/**
 * Configurações do app: chave da API do Gemini (guardada de forma segura no
 * PropertiesService do próprio script, nunca exposta ao cliente/navegador)
 * e status geral usado pela tela de Configurações.
 */

function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('Chave da API do Gemini não configurada. Acesse "Configurações" e cole a chave.');
  }
  return key;
}

function possuiChaveApi_() {
  return !!PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
}

/**
 * Chamada pelo formulário de Configurações. A chave nunca é lida de volta
 * pelo cliente — só é possível sobrescrevê-la ou verificar se já existe.
 */
function salvarChaveApi(key) {
  key = (key || '').trim();
  if (!key) throw new Error('Chave vazia.');
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  return true;
}

function removerChaveApi() {
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_API_KEY');
  return true;
}

function obterStatusConfiguracao() {
  var pasta = pastaApp_();
  var embFile = arquivoCache_(EMBEDDINGS_FILENAME, pasta);
  var totalEmbeddings = 0;
  if (embFile) {
    try {
      var store = JSON.parse(embFile.getBlob().getDataAsString('UTF-8'));
      totalEmbeddings = Object.keys(store).filter(function (k) { return store[k].vector; }).length;
    } catch (e) {
      totalEmbeddings = 0;
    }
  }
  return {
    possuiChaveApi: possuiChaveApi_(),
    ultimaAtualizacao: ultimaAtualizacaoInfo(),
    totalEmbeddings: totalEmbeddings
  };
}
