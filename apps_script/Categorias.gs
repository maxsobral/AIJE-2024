/**
 * Agregações de categorias para os dois blocos (mérito / interlocutórias),
 * listagens filtradas e obtenção do texto de uma decisão específica.
 */

var CAMPOS_CATEGORIA_MERITO = [
  { campo: 'Abuso poder economico', rotulo: 'Abuso de poder econômico' },
  { campo: 'Abuso poder politico', rotulo: 'Abuso de poder político' },
  { campo: 'Captacao ilicita sufragio', rotulo: 'Captação ilícita de sufrágio' },
  { campo: 'Captacao/gasto ilicito (30-A)', rotulo: 'Captação/gasto ilícito (art. 30-A)' },
  { campo: 'Conduta vedada', rotulo: 'Conduta vedada' },
  { campo: 'Fraude cota de genero', rotulo: 'Fraude a cota de gênero' },
  { campo: 'Uso indevido meios comunicacao', rotulo: 'Uso indevido de meios de comunicação' }
];

// Primeira regra cujo termo aparece no texto do movimento vence. Ordem importa.
var REGRAS_INTERLOCUTORIA = [
  { rotulo: 'Embargos de declaração', termos: ['embargos de declara'] },
  { rotulo: 'Liminar', termos: ['liminar'] },
  { rotulo: 'Diligência', termos: ['dilig'] },
  { rotulo: 'Emenda à inicial', termos: ['emenda'] },
  { rotulo: 'Suspensão/sobrestamento do processo', termos: ['suspens', 'sobrest'] },
  { rotulo: 'Decadência ou prescrição', termos: ['decad', 'prescri'] },
  { rotulo: 'Pedido não conhecido/recebido', termos: ['nao conhecido', 'não conhecido', 'nao recebid', 'não recebid'] },
  { rotulo: 'Arquivamento', termos: ['arquiv'] },
  { rotulo: 'Desistência', termos: ['desist'] },
  { rotulo: 'Recurso', termos: ['recurso', 'agravo', 'apela'] }
];

function classificarInterlocutoria_(movimento) {
  var texto = (movimento || '').toLowerCase();
  for (var i = 0; i < REGRAS_INTERLOCUTORIA.length; i++) {
    var regra = REGRAS_INTERLOCUTORIA[i];
    for (var j = 0; j < regra.termos.length; j++) {
      if (texto.indexOf(regra.termos[j]) !== -1) return regra.rotulo;
    }
  }
  return 'Outras decisões interlocutórias';
}

function resumoProcesso_(r) {
  return {
    id: r['ID'],
    processo: r['Processo'],
    municipio: r['Municipio'],
    zonaEleitoral: r['Zona Eleitoral'],
    autor: r['Autor (investigante)'],
    cargo: r['Cargo'],
    eleicao: r['Eleicao'],
    objeto: r['Objeto'],
    resultado: r['Resultado'],
    julgado: r['Julgado'],
    dataDistribuicao: r['Data distribuicao'],
    dataJulgamento: r['Data julgamento'],
    dataUltimaDecisao: r['Data ultima decisao ou julgamento'],
    movimentoUltimaDecisao: r['Movimento da ultima decisao ou julgamento']
  };
}

/**
 * Dados da tela inicial: totais e categorias mais populares de cada bloco.
 */
function obterResumoBlocos() {
  var dataset = carregarDataset_();
  var merito = [];
  var interlocutorias = [];

  dataset.forEach(function (r) {
    var cls = classificarRegistro_(r);
    if (cls.temMerito) merito.push(r);
    if (cls.temInterlocutoria) interlocutorias.push(r);
  });

  var categoriasMerito = CAMPOS_CATEGORIA_MERITO.map(function (c) {
    var count = merito.filter(function (r) { return r[c.campo] === 'Sim'; }).length;
    return { rotulo: c.rotulo, campo: c.campo, count: count };
  }).sort(function (a, b) { return b.count - a.count; });

  var resultadoCounts = {};
  merito.forEach(function (r) {
    var res = r['Resultado'] || 'Não informado';
    resultadoCounts[res] = (resultadoCounts[res] || 0) + 1;
  });
  var resultados = Object.keys(resultadoCounts)
    .map(function (k) { return { rotulo: k, count: resultadoCounts[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  var interlocCounts = {};
  interlocutorias.forEach(function (r) {
    var rotulo = classificarInterlocutoria_(r['Movimento da ultima decisao ou julgamento']);
    interlocCounts[rotulo] = (interlocCounts[rotulo] || 0) + 1;
  });
  var categoriasInterlocutorias = Object.keys(interlocCounts)
    .map(function (rotulo) { return { rotulo: rotulo, count: interlocCounts[rotulo] }; })
    .sort(function (a, b) { return b.count - a.count; });

  return {
    totalProcessos: dataset.length,
    ultimaAtualizacao: ultimaAtualizacaoInfo(),
    merito: { total: merito.length, categorias: categoriasMerito, resultados: resultados },
    interlocutorias: { total: interlocutorias.length, categorias: categoriasInterlocutorias }
  };
}

/**
 * Lista processos de um bloco, opcionalmente filtrados por categoria.
 * bloco: 'merito' | 'interlocutorias'
 * campo: nome do campo de flag (só para 'merito'); null = sem filtro
 * valor: rótulo da categoria (só para 'interlocutorias'); null = sem filtro
 */
function listarPorCategoria(bloco, campo, valor) {
  var dataset = carregarDataset_();
  var filtrados;

  if (bloco === 'merito') {
    filtrados = dataset.filter(function (r) {
      if (!classificarRegistro_(r).temMerito) return false;
      if (!campo) return true;
      return r[campo] === 'Sim';
    });
  } else {
    filtrados = dataset.filter(function (r) {
      var cls = classificarRegistro_(r);
      if (!cls.temInterlocutoria) return false;
      if (!valor) return true;
      return classificarInterlocutoria_(r['Movimento da ultima decisao ou julgamento']) === valor;
    });
  }

  return filtrados.map(resumoProcesso_);
}

/**
 * Retorna o texto (HTML) de uma decisão específica.
 * tipo: 'merito' | 'interlocutoria'
 */
function obterDecisao(id, tipo) {
  var dataset = carregarDataset_();
  var record = dataset.filter(function (r) { return String(r['ID']) === String(id); })[0];
  if (!record) throw new Error('Processo não encontrado ou indisponível: ' + id);

  var campoHtml = tipo === 'interlocutoria' ? 'Teor ultima decisao (HTML)' : 'Teor sentenca (HTML)';
  return {
    resumo: resumoProcesso_(record),
    html: record[campoHtml] || '',
    tipo: tipo
  };
}
