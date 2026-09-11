/**
 * Camada de dados: mantém um snapshot em cache no Drive (JSON) usado por todo
 * o app. O link do Metabase (fonte dos dados) é interno à rede do TRE-SC e
 * NÃO pode ser buscado por UrlFetchApp — o Apps Script executa nos
 * servidores do Google, que não têm rota/DNS para hosts internos da rede
 * corporativa. Por isso a atualização dos dados é feita por upload manual do
 * arquivo JSON exportado do Metabase (ver Configurações no app).
 */

var DATA_FOLDER_NAME = 'AIJE App Data';
var DATA_CACHE_FILENAME = 'aije_data_cache.json';
var IMPORT_TEMP_FILENAME = 'aije_data_cache.importando.json';
var EMBEDDINGS_FILENAME = 'aije_embeddings.json';

function pastaApp_() {
  var folders = DriveApp.getFoldersByName(DATA_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(DATA_FOLDER_NAME);
}

function arquivoCache_(nomeArquivo, pasta) {
  pasta = pasta || pastaApp_();
  var files = pasta.getFilesByName(nomeArquivo);
  return files.hasNext() ? files.next() : null;
}

/**
 * Importação em pedaços (o arquivo pode ter ~14MB — maior do que é seguro
 * mandar em uma única chamada de google.script.run). Fluxo, chamado pela
 * tela de Configurações:
 *   1. iniciarImportacao()
 *   2. enviarPedacoImportacao(pedaco) — uma vez por pedaço, em ordem
 *   3. finalizarImportacao() — valida o JSON e promove para o cache oficial
 */
function iniciarImportacao() {
  var pasta = pastaApp_();
  var tempFile = arquivoCache_(IMPORT_TEMP_FILENAME, pasta);
  if (tempFile) {
    tempFile.setContent('');
  } else {
    pasta.createFile(IMPORT_TEMP_FILENAME, '', MimeType.PLAIN_TEXT);
  }
  return true;
}

function enviarPedacoImportacao(pedaco) {
  var pasta = pastaApp_();
  var tempFile = arquivoCache_(IMPORT_TEMP_FILENAME, pasta);
  if (!tempFile) throw new Error('Importação não iniciada (chame iniciarImportacao primeiro).');
  var atual = tempFile.getBlob().getDataAsString('UTF-8');
  tempFile.setContent(atual + pedaco);
  return true;
}

function finalizarImportacao() {
  var pasta = pastaApp_();
  var tempFile = arquivoCache_(IMPORT_TEMP_FILENAME, pasta);
  if (!tempFile) throw new Error('Importação não iniciada.');

  var text = tempFile.getBlob().getDataAsString('UTF-8');
  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error('O arquivo enviado não é um JSON válido: ' + e.message);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('O JSON enviado não é uma lista de processos.');
  }

  var file = arquivoCache_(DATA_CACHE_FILENAME, pasta);
  if (file) {
    file.setContent(text);
  } else {
    pasta.createFile(DATA_CACHE_FILENAME, text, MimeType.PLAIN_TEXT);
  }
  tempFile.setTrashed(true);

  var agora = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty('LAST_DATA_REFRESH', agora);

  return { totalProcessos: parsed.length, atualizadoEm: agora };
}

/**
 * Carrega o dataset a partir do snapshot em cache no Drive.
 */
function carregarDataset_() {
  var pasta = pastaApp_();
  var file = arquivoCache_(DATA_CACHE_FILENAME, pasta);
  if (!file) {
    throw new Error(
      'Nenhum dado importado ainda. Acesse "Configurações" e envie o arquivo ' +
      'JSON exportado do Metabase.'
    );
  }
  var text = file.getBlob().getDataAsString('UTF-8');
  return JSON.parse(text);
}

function ultimaAtualizacaoInfo() {
  return PropertiesService.getScriptProperties().getProperty('LAST_DATA_REFRESH') || null;
}

// Mapa de entidades HTML nomeadas mais comuns nos textos de decisão exportados.
var HTML_ENTITIES_MAP_ = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í',
  oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', atilde: 'ã', Atilde: 'Ã',
  otilde: 'õ', Otilde: 'Õ', ccedil: 'ç', Ccedil: 'Ç', acirc: 'â', Acirc: 'Â',
  ecirc: 'ê', Ecirc: 'Ê', ocirc: 'ô', Ocirc: 'Ô', agrave: 'à', Agrave: 'À',
  uuml: 'ü', Uuml: 'Ü', ordm: 'º', ordf: 'ª', deg: '°', ldquo: '“',
  rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', ntilde: 'ñ', Ntilde: 'Ñ'
};

function decodeHtmlEntities_(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, function (m, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function (m, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    .replace(/&([a-zA-Z]+);/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(HTML_ENTITIES_MAP_, name)
        ? HTML_ENTITIES_MAP_[name]
        : m;
    });
}

function stripHtml_(html) {
  if (!html) return '';
  var semEstilo = html.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  var semTags = semEstilo.replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities_(semTags).replace(/\s+/g, ' ').trim();
}

/**
 * Classifica um registro nos dois blocos do app.
 * - Mérito: possui texto de sentença.
 * - Interlocutória: a última decisão existe e é diferente da sentença
 *   (inclui processos ainda não julgados no mérito).
 */
function classificarRegistro_(r) {
  var sentenca = r['Teor sentenca (HTML)'];
  var ultima = r['Teor ultima decisao (HTML)'];
  return {
    temMerito: !!sentenca,
    temInterlocutoria: !!ultima && ultima !== sentenca
  };
}
