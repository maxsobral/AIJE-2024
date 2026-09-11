// ---------- Cliente HTTP ----------

async function getJSON(url) {
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.erro || 'Erro desconhecido');
  return data;
}

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.erro || 'Erro desconhecido');
  return data;
}

async function postForm(url, formData) {
  const resp = await fetch(url, { method: 'POST', body: formData });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.erro || 'Erro desconhecido');
  return data;
}

const api = {
  status: () => getJSON('/api/status'),
  resumo: (q) => getJSON('/api/resumo' + (q ? '?' + new URLSearchParams({ q: q }) : '')),
  lista: (bloco, campo, valor) =>
    getJSON('/api/lista?' + new URLSearchParams({ bloco: bloco || '', campo: campo || '', valor: valor || '' })),
  decisao: (id, tipo) => getJSON('/api/decisao?' + new URLSearchParams({ id: id, tipo: tipo })),
  busca: (q, bloco) => getJSON('/api/busca?' + new URLSearchParams({ q: q, bloco: bloco })),
  salvarChave: (chave) => postJSON('/api/config/chave', { chave: chave }),
  atualizarDados: () => postJSON('/api/dados/atualizar'),
  gerarLoteEmbeddings: (tamanho) => postJSON('/api/embeddings/lote', { tamanho: tamanho }),
  similaridade: (file, bloco) => {
    var fd = new FormData();
    fd.append('arquivo', file);
    fd.append('bloco', bloco);
    return postForm('/api/similaridade', fd);
  },
};

// ---------- Helpers gerais ----------

function setApp(html) {
  document.getElementById('app').innerHTML = html;
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function erroHtml(err) {
  var msg = (err && err.message) ? err.message : String(err);
  return '<div class="erro">Erro: ' + escapeHtml(msg) + '</div>';
}

function formatarData(iso) {
  if (!iso) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso);
  if (!m) return iso;
  var data = m[3] + '-' + m[2] + '-' + m[1];
  return m[4] ? data + ' ' + m[4] + ':' + m[5] : data;
}

var CAMPO_ROTULOS = {
  'Abuso poder economico': 'Abuso de poder econômico',
  'Abuso poder politico': 'Abuso de poder político',
  'Captacao ilicita sufragio': 'Captação ilícita de sufrágio',
  'Captacao/gasto ilicito (30-A)': 'Captação/gasto ilícito (art. 30-A)',
  'Conduta vedada': 'Conduta vedada',
  'Fraude cota de genero': 'Fraude a cota de gênero',
  'Uso indevido meios comunicacao': 'Uso indevido de meios de comunicação'
};
function campoRotulo(campo) { return CAMPO_ROTULOS[campo] || campo; }

// ---------- Roteamento (hash-based) ----------

function parseHash() {
  var h = location.hash.replace(/^#\/?/, '');
  if (!h) return [];
  return h.split('/').map(decodeURIComponent);
}

function router() {
  var partes = parseHash();
  if (!partes.length || partes[0] === 'inicio') return renderInicio();
  if (partes[0] === 'lista') return renderLista(partes[1], partes[2], partes[3]);
  if (partes[0] === 'decisao') return renderDecisao(partes[1], partes[2]);
  if (partes[0] === 'similaridade') return renderSimilaridade();
  if (partes[0] === 'config') return renderConfig();
  return renderInicio();
}

window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', router);

// ---------- Tela: Início ----------

function blocosHtml(resumo) {
  var html = '<div class="blocos">';
  html += blocoCard(
    'interlocutorias',
    'Decisões Interlocutórias',
    resumo.interlocutorias.total,
    resumo.interlocutorias.categorias.map(function (c) {
      return { rotulo: c.rotulo, count: c.count, campo: null, valor: c.rotulo };
    })
  );
  html += blocoCard(
    'merito',
    'Decisões de Mérito',
    resumo.merito.total,
    resumo.merito.categorias.map(function (c) {
      return { rotulo: c.rotulo, count: c.count, campo: c.campo, valor: null };
    }),
    resumo.merito.resultados
  );
  html += '</div>';
  return html;
}

function tituloCaso(s) {
  return (s || '').toLowerCase().replace(/(^|\s)\S/g, function (c) { return c.toUpperCase(); });
}

function renderInfoRepositorio(resumo) {
  var classes = (resumo.classesDisponiveis || []).map(tituloCaso).map(escapeHtml).join(', ');

  var ultima = resumo.ultimaDecisaoIndexada;
  var ultimaHtml = 'não disponível';
  if (ultima) {
    var tipo = ultima.tipo === 'merito' ? 'merito' : 'interlocutoria';
    var tipoLabel = ultima.tipo === 'merito' ? 'Mérito' : 'Interlocutória';
    ultimaHtml = '<a href="#/decisao/' + encodeURIComponent(ultima.id) + '/' + tipo + '">' +
      escapeHtml(ultima.processo || String(ultima.id)) + '</a>' +
      ' (' + tipoLabel + ')' +
      (ultima.municipio ? ' · ' + escapeHtml(ultima.municipio) : '') +
      (ultima.data ? ' · ' + escapeHtml(formatarData(ultima.data)) : '');
  }

  return '<p class="subtitle">Classes disponíveis: ' + (classes || 'não disponível') + '</p>' +
    '<p class="subtitle">Última atualização: ' +
    (resumo.ultimaAtualizacao ? formatarData(resumo.ultimaAtualizacao) : 'dados ainda não sincronizados (veja Configurações)') +
    '</p>' +
    '<p class="subtitle">Última decisão indexada: ' + ultimaHtml + '</p>';
}

async function renderInicio() {
  setApp('<div class="loading">Carregando resumo…</div>');
  try {
    var resumo = await api.resumo();
    var html = '';
    html += '<h1>Repositório de decisões 1G - TRE-SC</h1>';
    html += '<p class="subtitle">' + resumo.totalProcessos + ' processo(s) na base</p>';
    html += renderInfoRepositorio(resumo);

    html += '<section class="card">' +
      '<form id="form-busca" class="form-inline">' +
      '<input type="text" id="busca-query" placeholder="Buscar por nome do candidato, município, fundamento..." required>' +
      '<select id="busca-bloco">' +
      '<option value="todos">Todos os blocos</option>' +
      '<option value="merito">Mérito</option>' +
      '<option value="interlocutorias">Interlocutórias</option>' +
      '</select>' +
      '<button type="submit">Buscar</button>' +
      '<button type="button" id="btn-limpar-busca" style="display:none;">Limpar</button>' +
      '</form>' +
      '<div id="busca-resultados"></div>' +
      '</section>';

    html += '<p class="subtitle" id="blocos-status"></p>';
    html += '<div id="blocos-container">' + blocosHtml(resumo) + '</div>';
    setApp(html);

    async function aplicarBusca(query, bloco) {
      var containerResultados = document.getElementById('busca-resultados');
      var containerBlocos = document.getElementById('blocos-container');
      var status = document.getElementById('blocos-status');
      var btnLimpar = document.getElementById('btn-limpar-busca');

      if (!query) {
        containerResultados.innerHTML = '';
        status.textContent = '';
        btnLimpar.style.display = 'none';
        try {
          containerBlocos.innerHTML = blocosHtml(await api.resumo());
        } catch (err) {
          containerBlocos.innerHTML = erroHtml(err);
        }
        return;
      }

      containerResultados.innerHTML = '<div class="loading">Buscando…</div>';
      btnLimpar.style.display = '';
      try {
        var resultadoBusca = await Promise.all([api.busca(query, bloco), api.resumo(query)]);
        var itens = resultadoBusca[0];
        var resumoFiltrado = resultadoBusca[1];
        containerResultados.innerHTML = itens.length ? renderTabelaBusca(itens) : '<p class="muted">Nenhum resultado encontrado.</p>';
        status.textContent = 'Categorias abaixo referentes a ' + resumoFiltrado.totalFiltrado + ' processo(s) que correspondem a "' + query + '"';
        containerBlocos.innerHTML = blocosHtml(resumoFiltrado);
      } catch (err) {
        containerResultados.innerHTML = erroHtml(err);
      }
    }

    document.getElementById('form-busca').addEventListener('submit', function (e) {
      e.preventDefault();
      var query = document.getElementById('busca-query').value.trim();
      var bloco = document.getElementById('busca-bloco').value;
      aplicarBusca(query, bloco);
    });

    document.getElementById('btn-limpar-busca').addEventListener('click', function () {
      document.getElementById('busca-query').value = '';
      aplicarBusca('', document.getElementById('busca-bloco').value);
    });
  } catch (err) {
    setApp(erroHtml(err));
  }
}

function blocoCard(bloco, titulo, total, categorias, resultados) {
  var chips = categorias.map(function (c) {
    var href = '#/lista/' + bloco + '/' + encodeURIComponent(c.campo || '') + '/' + encodeURIComponent(c.valor || '');
    return '<a class="chip" href="' + href + '">' + escapeHtml(c.rotulo) + ' <span class="chip-count">' + c.count + '</span></a>';
  }).join('');

  var resultadosHtml = '';
  if (resultados && resultados.length) {
    resultadosHtml = '<div class="resultados-mini">' + resultados.map(function (r) {
      return '<span class="badge">' + escapeHtml(r.rotulo) + ': ' + r.count + '</span>';
    }).join('') + '</div>';
  }

  return '<section class="card bloco-card">' +
    '<div class="bloco-header"><h2>' + escapeHtml(titulo) + '</h2><span class="bloco-total">' + total + ' processo(s)</span></div>' +
    '<div class="chips">' + (chips || '<p class="muted">Nenhuma categoria encontrada.</p>') + '</div>' +
    resultadosHtml +
    '<a class="ver-todos" href="#/lista/' + bloco + '//">Ver todos →</a>' +
    '</section>';
}

// ---------- Tela: Listagem por categoria (com ordenação e filtros) ----------

var COLUNAS_LISTA = {
  merito: [
    { key: 'processo', label: 'Processo', get: function (it) { return it.processo || String(it.id); } },
    { key: 'municipio', label: 'Município', get: function (it) { return it.municipio || ''; } },
    { key: 'autor', label: 'Autor', get: function (it) { return it.autor || ''; } },
    { key: 'extra', label: 'Resultado', get: function (it) { return it.resultado || ''; } },
    { key: 'data', label: 'Data', get: function (it) { return it.dataJulgamento || it.dataUltimaDecisao || ''; } }
  ],
  interlocutorias: [
    { key: 'processo', label: 'Processo', get: function (it) { return it.processo || String(it.id); } },
    { key: 'municipio', label: 'Município', get: function (it) { return it.municipio || ''; } },
    { key: 'autor', label: 'Autor', get: function (it) { return it.autor || ''; } },
    { key: 'extra', label: 'Movimento', get: function (it) { return it.movimentoUltimaDecisao || ''; } },
    { key: 'data', label: 'Data', get: function (it) { return it.dataUltimaDecisao || ''; } }
  ]
};

var listaState = null;

async function renderLista(bloco, campo, valor) {
  campo = campo || null;
  valor = valor || null;
  setApp('<div class="loading">Carregando…</div>');
  try {
    var items = await api.lista(bloco, campo, valor);
    var titulo = bloco === 'merito' ? 'Decisões de Mérito' : 'Decisões Interlocutórias';
    var subtitulo = campo ? campoRotulo(campo) : (valor || 'Todas as categorias');

    listaState = { bloco: bloco, items: items, sortKey: null, sortDir: 1, filtroTexto: '', filtroExtra: '' };

    var colunaExtra = COLUNAS_LISTA[bloco === 'merito' ? 'merito' : 'interlocutorias'][3];
    var valoresExtra = Array.from(new Set(items.map(function (it) { return colunaExtra.get(it) || 'Não informado'; }))).sort();

    var html = '<a class="voltar" href="#/inicio">← Início</a>';
    html += '<h1>' + escapeHtml(titulo) + '</h1>';
    html += '<p class="subtitle">' + escapeHtml(subtitulo) + '</p>';
    html += '<div class="filtros-lista">' +
      '<input type="text" id="lista-filtro-texto" placeholder="Filtrar por processo, município ou autor...">' +
      '<select id="lista-filtro-extra"><option value="">' + escapeHtml(colunaExtra.label) + ': todos</option>' +
      valoresExtra.map(function (v) { return '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>'; }).join('') +
      '</select>' +
      '</div>';
    html += '<p class="subtitle" id="lista-contagem"></p>';
    html += '<div id="lista-tabela-container"></div>';
    setApp(html);

    document.getElementById('lista-filtro-texto').addEventListener('input', function (e) {
      listaState.filtroTexto = e.target.value;
      renderizarTabelaListagem();
    });
    document.getElementById('lista-filtro-extra').addEventListener('change', function (e) {
      listaState.filtroExtra = e.target.value;
      renderizarTabelaListagem();
    });

    renderizarTabelaListagem();
  } catch (err) {
    setApp(erroHtml(err));
  }
}

function renderizarTabelaListagem() {
  var st = listaState;
  var colunas = COLUNAS_LISTA[st.bloco === 'merito' ? 'merito' : 'interlocutorias'];
  var tipo = st.bloco === 'merito' ? 'merito' : 'interlocutoria';
  var colunaExtra = colunas[3];

  var itens = st.items.filter(function (it) {
    if (st.filtroExtra && (colunaExtra.get(it) || 'Não informado') !== st.filtroExtra) return false;
    if (st.filtroTexto) {
      var termo = st.filtroTexto.toLowerCase();
      var alvo = [it.processo, it.municipio, it.autor].filter(Boolean).join(' ').toLowerCase();
      if (alvo.indexOf(termo) === -1) return false;
    }
    return true;
  });

  if (st.sortKey) {
    var col = colunas.filter(function (c) { return c.key === st.sortKey; })[0];
    itens.sort(function (a, b) {
      var va = col.get(a), vb = col.get(b);
      if (va < vb) return -1 * st.sortDir;
      if (va > vb) return 1 * st.sortDir;
      return 0;
    });
  }

  document.getElementById('lista-contagem').textContent = itens.length + ' de ' + st.items.length + ' processo(s)';

  var container = document.getElementById('lista-tabela-container');
  if (!itens.length) {
    container.innerHTML = '<p class="muted">Nenhum processo encontrado com esse filtro.</p>';
    return;
  }

  var thead = '<tr>' + colunas.map(function (c) {
    var seta = st.sortKey === c.key ? (st.sortDir === 1 ? ' ▲' : ' ▼') : '';
    return '<th class="th-sortable" data-key="' + c.key + '">' + escapeHtml(c.label) + seta + '</th>';
  }).join('') + '<th>Inteiro Teor</th></tr>';

  var linhas = itens.map(function (it) {
    var celulas = colunas.map(function (c) {
      var valor = c.get(it);
      return '<td>' + escapeHtml((c.key === 'data' ? formatarData(valor) : valor) || '—') + '</td>';
    }).join('');
    var linkTeor = '<td><a href="#/decisao/' + encodeURIComponent(it.id) + '/' + tipo + '">Ver inteiro teor →</a></td>';
    return '<tr>' + celulas + linkTeor + '</tr>';
  }).join('');

  container.innerHTML = '<table class="tabela"><thead>' + thead + '</thead><tbody>' + linhas + '</tbody></table>';

  container.querySelectorAll('.th-sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      var key = th.getAttribute('data-key');
      if (listaState.sortKey === key) {
        listaState.sortDir *= -1;
      } else {
        listaState.sortKey = key;
        listaState.sortDir = 1;
      }
      renderizarTabelaListagem();
    });
  });
}

// ---------- Tela: Decisão ----------

async function renderDecisao(id, tipo) {
  setApp('<div class="loading">Carregando decisão…</div>');
  try {
    var dados = await api.decisao(id, tipo);
    var r = dados.resumo;
    var html = '<a class="voltar" href="javascript:history.back()">← Voltar</a>';
    html += '<h1>' + escapeHtml(r.processo || ('Processo ' + r.id)) + '</h1>';
    html += '<div class="meta-grid">' +
      metaItem('Município', r.municipio) + metaItem('Zona Eleitoral', r.zonaEleitoral) +
      metaItem('Autor', r.autor) + metaItem('Cargo', r.cargo) +
      metaItem('Eleição', r.eleicao) + metaItem('Resultado', r.resultado) +
      metaItem('Data julgamento', r.dataJulgamento && formatarData(r.dataJulgamento)) +
      metaItem('Última decisão', r.dataUltimaDecisao && formatarData(r.dataUltimaDecisao)) +
      '</div>';
    html += '<div class="decisao-box">' + (dados.html || '<p class="muted">Sem conteúdo disponível.</p>') + '</div>';
    setApp(html);
  } catch (err) {
    setApp(erroHtml(err));
  }
}

function metaItem(label, value) {
  return '<div class="meta-item"><span class="meta-label">' + escapeHtml(label) + '</span>' +
    '<span class="meta-value">' + escapeHtml(value !== null && value !== undefined ? String(value) : '—') + '</span></div>';
}

// ---------- Tabela de resultados de busca (usada na Início) ----------

function renderTabelaBusca(itens) {
  var linhas = itens.map(function (it) {
    var links = [];
    if (it.temMerito) links.push('<a href="#/decisao/' + encodeURIComponent(it.id) + '/merito">Inteiro teor (Mérito)</a>');
    if (it.temInterlocutoria) links.push('<a href="#/decisao/' + encodeURIComponent(it.id) + '/interlocutoria">Inteiro teor (Interlocutória)</a>');
    return '<tr>' +
      '<td>' + escapeHtml(it.processo || it.id) + '</td>' +
      '<td>' + escapeHtml(it.municipio || '') + '</td>' +
      '<td>' + escapeHtml((it.objeto || '').slice(0, 140)) + '</td>' +
      '<td>' + links.join(' · ') + '</td>' +
      '</tr>';
  }).join('');
  return '<table class="tabela"><thead><tr><th>Processo</th><th>Município</th><th>Objeto</th><th>Inteiro Teor</th></tr></thead><tbody>' + linhas + '</tbody></table>';
}

// ---------- Tela: Verificar Similaridade ----------

function renderSimilaridade() {
  var html = '<h1>Verificar similaridade de peça</h1>' +
    '<p class="subtitle">Envie um PDF (petição, recurso, defesa etc.) para localizar julgados semelhantes na base, usando IA (Gemini).</p>' +
    '<form id="form-similaridade" class="form-stack">' +
    '<input type="file" id="sim-arquivo" accept="application/pdf" required>' +
    '<select id="sim-bloco">' +
    '<option value="todos">Todos os blocos</option>' +
    '<option value="merito">Mérito</option>' +
    '<option value="interlocutorias">Interlocutórias</option>' +
    '</select>' +
    '<button type="submit">Analisar e comparar</button>' +
    '</form>' +
    '<div id="sim-resultados"></div>';
  setApp(html);

  document.getElementById('form-similaridade').addEventListener('submit', async function (e) {
    e.preventDefault();
    var fileInput = document.getElementById('sim-arquivo');
    var bloco = document.getElementById('sim-bloco').value;
    var container = document.getElementById('sim-resultados');
    var file = fileInput.files[0];
    if (!file) return;
    if (file.type !== 'application/pdf') {
      container.innerHTML = '<div class="erro">Envie um arquivo PDF.</div>';
      return;
    }
    container.innerHTML = '<div class="loading">Lendo o PDF e comparando com a base (pode levar até 1 minuto)…</div>';
    try {
      var resp = await api.similaridade(file, bloco);
      container.innerHTML = renderResultadosSimilaridade(resp);
    } catch (err) {
      container.innerHTML = erroHtml(err);
    }
  });
}

function renderResultadosSimilaridade(resp) {
  var avisoTruncado = resp.truncado
    ? '<p class="muted">O texto extraído era maior — apenas os primeiros ' + resp.textoConsiderado.length + ' caracteres abaixo foram usados na comparação (limite do modelo de embedding).</p>'
    : '';

  var analiseHtml = '<h2>Análise da peça</h2>' +
    avisoTruncado +
    '<details class="preview-extraido" open><summary>Conteúdo completo considerado na pesquisa</summary>' +
    '<pre>' + escapeHtml(resp.textoConsiderado) + '</pre></details>';

  var listaHtml;
  if (!resp.resultados.length) {
    listaHtml = '<p class="muted">Nenhum resultado. Gere os embeddings da base em Configurações antes de usar esta ferramenta.</p>';
  } else {
    var lista = resp.resultados.map(function (r) {
      var pct = (r.score * 100).toFixed(1) + '%';
      var tipo = r.tipo === 'merito' ? 'merito' : 'interlocutoria';
      var destaque = '';
      if (r.trechoRelevante) {
        destaque = '<blockquote class="sim-trecho">"' + escapeHtml(r.trechoRelevante) + '"</blockquote>' +
          (r.motivoRelevancia ? '<div class="sim-motivo">' + escapeHtml(r.motivoRelevancia) + '</div>' : '');
      }
      return '<li class="sim-item">' +
        '<div class="sim-score">' + pct + '</div>' +
        '<div class="sim-info">' +
        '<a href="#/decisao/' + encodeURIComponent(r.resumo.id) + '/' + tipo + '">' + escapeHtml(r.resumo.processo || r.resumo.id) + '</a>' +
        '<div class="muted">' + escapeHtml(r.resumo.municipio || '') + ' · ' + (r.tipo === 'merito' ? 'Mérito' : 'Interlocutória') + '</div>' +
        destaque +
        '</div></li>';
    }).join('');
    listaHtml = '<h2>Julgados mais semelhantes</h2><ul class="sim-lista">' + lista + '</ul>';
  }

  return analiseHtml + listaHtml;
}

// ---------- Tela: Configurações ----------

async function renderConfig() {
  setApp('<div class="loading">Carregando configurações…</div>');
  try {
    var status = await api.status();
    var html = '<h1>Configurações</h1>';

    html += '<section class="card">' +
      '<h2>Chave da API do Gemini</h2>' +
      '<p class="muted">Status: ' + (status.possuiChaveApi ? '<span class="ok">configurada</span>' : '<span class="atencao">não configurada</span>') + '</p>' +
      '<form id="form-chave" class="form-inline">' +
      '<input type="password" id="chave-api" placeholder="Cole a chave da API do Gemini" required>' +
      '<button type="submit">Salvar</button>' +
      '</form>' +
      '<div id="chave-msg"></div>' +
      '</section>';

    html += '<section class="card">' +
      '<h2>Dados da base (Metabase)</h2>' +
      '<p class="muted">Última atualização: ' + (status.ultimaAtualizacao ? formatarData(status.ultimaAtualizacao) : 'nunca') + '</p>' +
      '<button id="btn-atualizar-dados">Atualizar dados agora</button>' +
      '<div id="dados-msg"></div>' +
      '</section>';

    html += '<section class="card">' +
      '<h2>Embeddings para verificação de similaridade</h2>' +
      '<p class="muted">Registros indexados: ' + status.totalEmbeddings + '</p>' +
      '<button id="btn-gerar-embeddings">Gerar mais um lote</button>' +
      '<div id="emb-msg"></div>' +
      '</section>';

    setApp(html);

    document.getElementById('form-chave').addEventListener('submit', async function (e) {
      e.preventDefault();
      var msg = document.getElementById('chave-msg');
      msg.textContent = 'Salvando…';
      try {
        await api.salvarChave(document.getElementById('chave-api').value);
        document.getElementById('chave-api').value = '';
        msg.innerHTML = '<span class="ok">Chave salva com sucesso.</span>';
      } catch (err) {
        msg.innerHTML = erroHtml(err);
      }
    });

    document.getElementById('btn-atualizar-dados').addEventListener('click', async function () {
      var msg = document.getElementById('dados-msg');
      msg.textContent = 'Atualizando (buscando direto do Metabase, pode levar alguns segundos)…';
      try {
        var res = await api.atualizarDados();
        msg.innerHTML = '<span class="ok">' + res.totalProcessos + ' processo(s) atualizado(s).</span>';
      } catch (err) {
        msg.innerHTML = erroHtml(err);
      }
    });

    document.getElementById('btn-gerar-embeddings').addEventListener('click', async function () {
      var msg = document.getElementById('emb-msg');
      msg.textContent = 'Gerando lote (pode levar alguns minutos)…';
      try {
        var res = await api.gerarLoteEmbeddings(25);
        msg.innerHTML = '<span class="ok">' + res.processadosAgora + ' processado(s) agora. Restam ' +
          res.restantes + '. Total indexado: ' + res.totalArmazenado + '.</span>' +
          (res.restantes > 0 ? ' <em>Clique novamente para continuar.</em>' : '');
      } catch (err) {
        msg.innerHTML = erroHtml(err);
      }
    });
  } catch (err) {
    setApp(erroHtml(err));
  }
}
