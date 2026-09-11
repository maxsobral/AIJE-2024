/**
 * Busca textual simples (linear em memória — o corpus é pequeno, ~200
 * processos, então não é necessário nenhum índice de texto completo).
 */

// Faixa Unicode 0x0300-0x036F = marcas diacríticas combinantes (usadas após
// normalize('NFD') para separar letra base + acento).
var DIACRITICS_REGEX_ = new RegExp(
  '[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']',
  'g'
);

function normalizarTexto_(s) {
  return decodeHtmlEntities_(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX_, ''); // remove marcas diacríticas para comparação
}

/**
 * bloco: 'merito' | 'interlocutorias' | 'todos'
 */
function buscar(query, bloco) {
  query = (query || '').trim();
  if (!query) return [];

  var termo = normalizarTexto_(query);
  var dataset = carregarDataset_();
  var resultados = [];

  dataset.forEach(function (r) {
    var cls = classificarRegistro_(r);
    if (bloco === 'merito' && !cls.temMerito) return;
    if (bloco === 'interlocutorias' && !cls.temInterlocutoria) return;
    if (bloco !== 'merito' && bloco !== 'interlocutorias' && !cls.temMerito && !cls.temInterlocutoria) return;

    var partes = [
      r['Objeto'], r['Autor (investigante)'], r['Municipio'], r['Zona Eleitoral'],
      r['Processo'], stripHtml_(r['Teor sentenca (HTML)']), stripHtml_(r['Teor ultima decisao (HTML)'])
    ].filter(Boolean);

    var textoBusca = normalizarTexto_(partes.join(' \n '));
    if (textoBusca.indexOf(termo) !== -1) {
      var resumo = resumoProcesso_(r);
      resumo.temMerito = cls.temMerito;
      resumo.temInterlocutoria = cls.temInterlocutoria;
      resultados.push(resumo);
    }
  });

  return resultados.slice(0, 100);
}
