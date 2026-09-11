# Consulta de Decisões AIJE (TRE-SC) — Google Apps Script

Site interno para consultar decisões de Ações de Investigação Judicial Eleitoral
(AIJE), organizado em dois blocos — **Decisões Interlocutórias** e **Decisões de
Mérito** — com categorias mais populares, busca textual e verificação de
similaridade de peças (PDF) usando a API do Gemini.

## Status

- Projeto Apps Script criado e publicado via `clasp` (login: `sobral@tre-sc.jus.br`).
- Web app: `https://script.google.com/macros/s/AKfycbx-jwlbOjT4r7Fr21r0OxjBRZciEJy1LtvkVwUe5mAyXiqO2GolxVTjnitvPDcan3eLHg/exec`
- Editor do projeto: `https://script.google.com/d/1SuWYcfgtsWPxB9JLdquHq6wik3s3XUbXT6xkDwHpuwH0_5wmXqWE77Kf/edit`

## Fonte dos dados — importante

Os dados vêm de uma pergunta do Metabase do TRE-SC:

```
https://metabasepje.tre-sc.gov.br/public/question/529fc0b8-0e8a-4b82-a751-dafdab59f297.json
```

Esse host é **interno à rede do TRE-SC**. O Apps Script executa nos
servidores do Google, que não têm rota/DNS para esse endereço — por isso
`UrlFetchApp.fetch()` sempre falha com erro de DNS ao tentar buscar esse link
diretamente. Não é um problema de configuração corrigível; é uma limitação
de rede real.

**Fluxo de atualização dos dados (manual, dentro da rede do TRE-SC):**

1. Abra o link do Metabase acima no seu navegador (precisa estar na rede/VPN
   do TRE-SC).
2. Baixe o resultado como JSON (Metabase tem uma opção de download/export).
3. No site, vá em **Configurações** → seção "Dados da base" → selecione o
   arquivo baixado → clique em **Importar arquivo**.

O upload é feito em pedaços de ~500KB (o arquivo tem ~14MB) para não
estourar o limite de tamanho de uma chamada única ao servidor. Acompanhe a
mensagem de progresso ("Enviando parte X de Y…"). Ao final, os dados ficam
em cache no Google Drive (pasta **"AIJE App Data"**) e todo o app passa a
usar esse snapshot — repita esse processo sempre que quiser atualizar os
dados.

> **Sigilo de justiça:** por decisão explícita, processos com
> `Segredo de justica = Sim` são tratados como qualquer outro em toda a
> aplicação — aparecem em listagens, busca, visualização e também entram na
> geração de embeddings e na verificação de similaridade (ou seja, o texto
> deles é enviado ao Gemini como o de qualquer outro processo).

## Configuração inicial (dentro do site)

Abra a URL do Web App e vá em **Configurações**:

1. **Cole a chave da API do Gemini** e clique em Salvar (fica guardada no
   `PropertiesService` do script — nunca aparece em nenhum arquivo do
   projeto nem é enviada de volta ao navegador).
2. Importe o arquivo JSON do Metabase (ver seção acima).
3. Clique em **Gerar mais um lote** (embeddings) repetidamente até "Restam"
   chegar a 0. Cada clique processa ~20 decisões; com ~260 decisões
   (mérito + interlocutórias) esperam-se uns 13 cliques. Repita depois de
   cada importação que trouxer processos novos.

Depois disso, a Home, a Busca e a Verificação de Similaridade já funcionam
para qualquer pessoa com acesso ao link (domínio `tre-sc.jus.br`).

**Se algum botão der erro de permissão na primeira execução real:** abra o
editor do projeto, escolha uma função no menu suspenso (ex.
`iniciarImportacao`) e clique em "Executar" uma vez para completar a tela de
consentimento de escopos (Drive, rede externa) — depois disso o site
funciona normalmente.

## Publicar atualizações de código

Com Node.js e `@google/clasp` já instalados e autenticados nesta máquina,
qualquer alteração nos arquivos dentro de `apps_script/` pode ser publicada
com:

```
clasp push        # envia os arquivos alterados para o projeto
clasp deploy      # cria uma nova versão publicada do web app
```

(rodar dentro da pasta `apps_script/`, com o Node instalado via winget no
PATH da sessão).

## Modelos do Gemini usados

Definidos no topo de `Similaridade.gs`:

- `gemini-2.5-flash` — leitura/extração de texto do PDF enviado (multimodal,
  entende PDF nativamente, inclusive digitalizado).
- `text-embedding-004` — geração dos vetores de embedding usados na
  similaridade de cosseno.

Se sua conta tiver acesso a versões mais novas, é só trocar essas constantes,
rodar `clasp push` e `clasp deploy`.

## Limitações conhecidas

- **Atualização de dados é manual** (ver seção "Fonte dos dados" acima) —
  o Apps Script não consegue buscar o Metabase interno diretamente.
- O Apps Script tem limite de **6 minutos por execução**. A geração de
  embeddings roda em lotes (padrão: 20 por clique) exatamente por causa
  disso — clique em "Gerar mais um lote" até zerar o restante.
- A busca e a listagem carregam o snapshot inteiro (~14MB) da memória a cada
  chamada. Para ~200 processos isso é rápido o suficiente para um uso
  interno; se a base crescer muito, vale considerar um índice mais leve.
