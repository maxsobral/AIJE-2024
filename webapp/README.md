# Consulta de Decisões AIJE (TRE-SC) — app local (Flask)

Site interno para consultar decisões de Ações de Investigação Judicial Eleitoral
(AIJE), organizado em dois blocos — **Decisões Interlocutórias** e **Decisões de
Mérito** — com categorias mais populares, busca textual e verificação de
similaridade de peças (PDF) usando a API do Gemini.

Este projeto **substitui a versão anterior em Google Apps Script** — o Apps
Script roda nos servidores do Google, que não têm rota para o Metabase interno
do TRE-SC (`metabasepje.tre-sc.gov.br`), então a atualização de dados exigia
upload manual. Rodando localmente, dentro da rede do TRE-SC, a aplicação
busca o Metabase diretamente, sem passos manuais.

## Como rodar

```
cd webapp
pip install -r requirements.txt
python app.py
```

Abra **http://127.0.0.1:5000** no navegador.

## Configuração inicial (dentro do site)

Vá em **Configurações**:

1. Cole a chave da API do Gemini e clique em Salvar (fica em
   `webapp/data/config.json`, só nesta máquina — nunca é enviada de volta ao
   navegador).
2. Clique em **Atualizar dados agora** — busca o JSON direto do Metabase
   (rede interna) e grava um cache local em `webapp/data/aije_data_cache.json`.
3. Clique em **Gerar mais um lote** (embeddings) repetidamente até "Restam"
   chegar a 0. Cada clique processa ~25 decisões; repita depois de cada
   atualização de dados que trouxer processos novos.

## Rede / proxy

- A busca ao Metabase (`data_layer.atualizar_dados`) é feita **sem proxy**
  (`NO_PROXY` em `data_layer.py`) porque o host é interno à rede do TRE-SC.
- As chamadas ao Gemini (`gemini_client.py`) usam o proxy corporativo de
  saída, lido das variáveis de ambiente `https_proxy`/`http_proxy`. Se a
  senha do proxy tiver caracteres especiais (`@`, `:`), o código já
  recodifica a URL do proxy automaticamente antes de usá-la.

> **Sigilo de justiça:** por decisão explícita, processos com
> `Segredo de justica = Sim` são tratados como qualquer outro em toda a
> aplicação — aparecem em listagens, busca, visualização e também entram na
> geração de embeddings e na verificação de similaridade (ou seja, o texto
> deles é enviado ao Gemini como o de qualquer outro processo).

## Modelos do Gemini usados

Definidos no topo de `gemini_client.py`:

- `gemini-2.5-flash` — leitura/extração de texto do PDF enviado.
- `text-embedding-004` — geração dos vetores de embedding.

## Arquivos gerados em tempo de execução (`webapp/data/`)

- `config.json` — chave da API e data da última atualização.
- `aije_data_cache.json` — snapshot dos processos vindo do Metabase.
- `aije_embeddings.json` — vetores de embedding por processo/tipo.

Nenhum desses arquivos deve ser versionado em um repositório compartilhado
(contêm a chave de API e, potencialmente, dados de processos).

## Publicar na internet (deploy)

> **Atenção:** o Metabase (`metabasepje.tre-sc.gov.br`) só é alcançável de
> dentro da rede do TRE-SC — foi por isso que a versão anterior em Apps
> Script foi abandonada (servidores do Google não tinham rota até lá). Um
> servidor hospedado na internet está na mesma situação: consegue servir a
> aplicação normalmente a partir do cache já gerado, mas o botão
> **"Atualizar dados agora"** não vai funcionar por lá. Para atualizar os
> dados, rode a atualização localmente (dentro da rede do TRE-SC) e reenvie
> os arquivos de `webapp/data/` para o servidor.

Passos (usando um serviço como Render, que builda direto do GitHub):

1. No painel do serviço, aponte para este repositório, com **Root Directory**
   = `webapp`.
2. Build command: `pip install -r requirements.txt`.
3. Start command: já definido no `Procfile` (`gunicorn app:app ...`).
4. Defina a variável de ambiente `GEMINI_API_KEY` com a chave da API (o
   `config.json` local não é versionado, então em produção a chave só vem
   dessa variável — ver `data_layer.get_api_key`).
5. Aponte seu domínio para o serviço, conforme instruções do provedor.

## Projeto Google Apps Script anterior

A pasta `apps_script/` (versão anterior, descontinuada por não conseguir
acessar o Metabase interno) foi mantida no repositório apenas para
referência histórica.
