/**
 * Ponto de entrada do Web App.
 */
function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Consulta de Decisões AIJE - TRE-SC')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// Usado pelos templates HTML para incluir CSS/JS: <?!= include('Styles'); ?>
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
