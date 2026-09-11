/**
 * Integração com o Gemini: leitura de PDF, geração de embeddings da base
 * (rodada uma vez, em lotes) e verificação de similaridade de uma peça
 * enviada contra os julgados já indexados.
 *
 * Os nomes de modelo abaixo são os estáveis no momento em que este projeto
 * foi escrito; se a conta tiver acesso a versões mais novas, basta trocar
 * as constantes.
 */

var GEMINI_MODEL_GENERATIVO = 'gemini-2.5-flash';
var GEMINI_MODEL_EMBEDDING = 'text-embedding-004';
var GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

function chamarGeminiGerarConteudo_(parts) {
  var apiKey = getApiKey_();
  var url = GEMINI_API_BASE + GEMINI_MODEL_GENERATIVO + ':generateContent?key=' + encodeURIComponent(apiKey);
  var payload = { contents: [{ parts: parts }] };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = JSON.parse(response.getContentText());
  if (code !== 200) {
    throw new Error('Erro Gemini (' + code + '): ' + (body.error ? body.error.message : response.getContentText()));
  }
  return body;
}

function extrairTextoPdf_(base64Pdf) {
  var parts = [
    {
      text:
        'Extraia o conteúdo textual relevante desta peça jurídica eleitoral ' +
        '(petição, recurso, defesa, decisão etc.), preservando os principais ' +
        'fatos, fundamentos jurídicos e pedidos. Responda apenas com o texto ' +
        'extraído/resumido, em português, sem comentários adicionais, em até ' +
        '6000 caracteres.'
    },
    { inlineData: { mimeType: 'application/pdf', data: base64Pdf } }
  ];

  var result = chamarGeminiGerarConteudo_(parts);
  var candidato = result.candidates && result.candidates[0];
  var texto = candidato && candidato.content && candidato.content.parts
    ? candidato.content.parts.map(function (p) { return p.text || ''; }).join('\n')
    : '';

  if (!texto) throw new Error('Não foi possível extrair texto do PDF enviado.');
  return texto.trim();
}

function chamarGeminiEmbedding_(texto) {
  var apiKey = getApiKey_();
  var url = GEMINI_API_BASE + GEMINI_MODEL_EMBEDDING + ':embedContent?key=' + encodeURIComponent(apiKey);
  var payload = {
    model: 'models/' + GEMINI_MODEL_EMBEDDING,
    content: { parts: [{ text: texto }] }
  };

  var response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = response.getResponseCode();
  var body = JSON.parse(response.getContentText());
  if (code !== 200) {
    throw new Error('Erro Gemini embedding (' + code + '): ' + (body.error ? body.error.message : response.getContentText()));
  }
  return body.embedding.values;
}

function truncarParaEmbedding_(texto, maxChars) {
  maxChars = maxChars || 8000;
  if (!texto) return '';
  return texto.length > maxChars ? texto.slice(0, maxChars) : texto;
}

function similaridadeCosseno_(a, b) {
  var dot = 0, na = 0, nb = 0;
  var len = Math.min(a.length, b.length);
  for (var i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Gera embeddings para os registros ainda não indexados, em lotes (para
 * respeitar o limite de execução de 6 minutos do Apps Script). Chamar
 * repetidamente (botão "Gerar mais um lote" na tela de Configurações) até
 * "restantes" chegar a 0.
 */
function gerarLoteEmbeddings(tamanhoLote) {
  tamanhoLote = tamanhoLote || 20;
  var dataset = carregarDataset_();
  var pasta = pastaApp_();
  var embFile = arquivoCache_(EMBEDDINGS_FILENAME, pasta);
  var store = {};
  if (embFile) {
    try {
      store = JSON.parse(embFile.getBlob().getDataAsString('UTF-8'));
    } catch (e) {
      store = {};
    }
  }

  var pendentes = [];
  dataset.forEach(function (r) {
    var cls = classificarRegistro_(r);
    var id = String(r['ID']);
    if (cls.temMerito) {
      var chaveMerito = id + '_merito';
      if (!store[chaveMerito] || store[chaveMerito].error) {
        pendentes.push({ chave: chaveMerito, id: id, tipo: 'merito', texto: stripHtml_(r['Teor sentenca (HTML)']) });
      }
    }
    if (cls.temInterlocutoria) {
      var chaveInter = id + '_interlocutoria';
      if (!store[chaveInter] || store[chaveInter].error) {
        pendentes.push({ chave: chaveInter, id: id, tipo: 'interlocutoria', texto: stripHtml_(r['Teor ultima decisao (HTML)']) });
      }
    }
  });

  var lote = pendentes.slice(0, tamanhoLote);
  var inicio = Date.now();
  var processados = 0;

  for (var i = 0; i < lote.length; i++) {
    if (Date.now() - inicio > 4.5 * 60 * 1000) break; // margem de segurança do limite de execução
    var item = lote[i];
    try {
      var vetor = chamarGeminiEmbedding_(truncarParaEmbedding_(item.texto));
      store[item.chave] = { id: item.id, tipo: item.tipo, vector: vetor };
      processados++;
    } catch (e) {
      store[item.chave] = { id: item.id, tipo: item.tipo, error: String(e) };
    }
  }

  var conteudo = JSON.stringify(store);
  if (embFile) {
    embFile.setContent(conteudo);
  } else {
    pasta.createFile(EMBEDDINGS_FILENAME, conteudo, MimeType.PLAIN_TEXT);
  }

  return {
    processadosAgora: processados,
    restantes: pendentes.length - processados,
    totalPendenteAntes: pendentes.length,
    totalArmazenado: Object.keys(store).length
  };
}

/**
 * Recebe o PDF em base64, extrai o texto via Gemini, gera o embedding da
 * peça e retorna os julgados mais similares já indexados.
 * bloco: 'merito' | 'interlocutorias' | 'todos'
 */
function verificarSimilaridade(base64Pdf, bloco, topN) {
  topN = topN || 8;

  var textoExtraido = extrairTextoPdf_(base64Pdf);
  var vetorConsulta = chamarGeminiEmbedding_(truncarParaEmbedding_(textoExtraido));

  var pasta = pastaApp_();
  var embFile = arquivoCache_(EMBEDDINGS_FILENAME, pasta);
  if (!embFile) {
    throw new Error('Nenhum embedding gerado ainda. Acesse "Configurações" e gere os embeddings da base primeiro.');
  }
  var store = JSON.parse(embFile.getBlob().getDataAsString('UTF-8'));

  var dataset = carregarDataset_();
  var porId = {};
  dataset.forEach(function (r) { porId[String(r['ID'])] = r; });

  var tipoFiltro = bloco === 'merito' ? 'merito' : (bloco === 'interlocutorias' ? 'interlocutoria' : null);

  var pontuados = [];
  Object.keys(store).forEach(function (chave) {
    var entrada = store[chave];
    if (!entrada.vector) return;
    if (tipoFiltro && entrada.tipo !== tipoFiltro) return;
    var registro = porId[entrada.id];
    if (!registro) return;
    var score = similaridadeCosseno_(vetorConsulta, entrada.vector);
    var resumo = resumoProcesso_(registro);
    pontuados.push({ score: score, tipo: entrada.tipo, resumo: resumo });
  });

  pontuados.sort(function (a, b) { return b.score - a.score; });

  return {
    textoExtraidoPreview: textoExtraido.slice(0, 800),
    resultados: pontuados.slice(0, topN)
  };
}
