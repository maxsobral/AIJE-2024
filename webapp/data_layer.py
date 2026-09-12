"""
Camada de dados: busca o export do Metabase (rede interna do TRE-SC), mantém
um snapshot em cache local (JSON em disco) e expõe funções de categorização,
listagem e busca usadas pelas rotas do Flask.
"""
import html
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import requests

METABASE_URL = (
    "https://metabasepje.tre-sc.gov.br/public/question/"
    "cdee7e27-5c61-4a5f-8d0b-806cd4a0af58.json"
)

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CACHE_PATH = os.path.join(DATA_DIR, "aije_data_cache.json")
EMBEDDINGS_PATH = os.path.join(DATA_DIR, "aije_embeddings.json")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")

# Requisições ao Metabase não devem usar o proxy corporativo de saída — o
# host é interno à rede do TRE-SC, então precisam ir direto.
NO_PROXY = {"http": None, "https": None}

CAMPOS_CATEGORIA_MERITO = [
    {"campo": "Abuso poder economico", "rotulo": "Abuso de poder econômico"},
    {"campo": "Abuso poder politico", "rotulo": "Abuso de poder político"},
    {"campo": "Captacao ilicita sufragio", "rotulo": "Captação ilícita de sufrágio"},
    {"campo": "Captacao/gasto ilicito (30-A)", "rotulo": "Captação/gasto ilícito (art. 30-A)"},
    {"campo": "Conduta vedada", "rotulo": "Conduta vedada"},
    {"campo": "Fraude cota de genero", "rotulo": "Fraude a cota de gênero"},
    {"campo": "Uso indevido meios comunicacao", "rotulo": "Uso indevido de meios de comunicação"},
]

# Primeira regra cujo termo aparece no texto do movimento vence. Ordem importa.
REGRAS_INTERLOCUTORIA = [
    ("Embargos de declaração", ["embargos de declara"]),
    ("Liminar", ["liminar"]),
    ("Diligência", ["dilig"]),
    ("Emenda à inicial", ["emenda"]),
    ("Suspensão/sobrestamento do processo", ["suspens", "sobrest"]),
    ("Decadência ou prescrição", ["decad", "prescri"]),
    ("Pedido não conhecido/recebido", ["nao conhecido", "não conhecido", "nao recebid", "não recebid"]),
    ("Arquivamento", ["arquiv"]),
    ("Desistência", ["desist"]),
    ("Recurso", ["recurso", "agravo", "apela"]),
]


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _read_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_json(path, obj):
    """Escreve em arquivo temporário e substitui com os.replace (atômico), para
    não corromper o arquivo se dois processos (ex.: workers do gunicorn)
    gravarem por perto um do outro."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False)
    os.replace(tmp_path, path)


# ---------- Configuração (chave da API, metadados) ----------

def get_config():
    return _read_json(CONFIG_PATH, {}) or {}


def save_api_key(key):
    key = (key or "").strip()
    if not key:
        raise ValueError("Chave vazia.")
    cfg = get_config()
    cfg["gemini_api_key"] = key
    _write_json(CONFIG_PATH, cfg)


def get_api_key():
    key = os.environ.get("GEMINI_API_KEY") or get_config().get("gemini_api_key")
    if not key:
        raise RuntimeError('Chave da API do Gemini não configurada. Acesse "Configurações".')
    return key


def has_api_key():
    return bool(os.environ.get("GEMINI_API_KEY") or get_config().get("gemini_api_key"))


def get_last_refresh():
    """Data da última sincronização. Vem do config.json quando a atualização foi
    feita por este servidor (rota /api/dados/atualizar); como esse arquivo não é
    versionado (guarda também a chave da API), em produção ele não existe — nesse
    caso cai para o campo "Atualizado em" que o próprio Metabase grava em cada
    processo no momento da exportação."""
    val = get_config().get("ultima_atualizacao")
    if val:
        return val
    try:
        dataset = carregar_dataset()
    except RuntimeError:
        return None
    valores = {r.get("Atualizado em") for r in dataset if r.get("Atualizado em")}
    if not valores:
        return None
    return max(valores).replace(" ", "T")


def set_last_refresh(iso):
    cfg = get_config()
    cfg["ultima_atualizacao"] = iso
    _write_json(CONFIG_PATH, cfg)


# ---------- Dados (Metabase) ----------

def atualizar_dados():
    """Busca o JSON direto do Metabase (rede interna) e grava o cache local."""
    resp = requests.get(METABASE_URL, proxies=NO_PROXY, timeout=120)
    resp.raise_for_status()
    dataset = resp.json()
    if not isinstance(dataset, list):
        raise ValueError("O retorno do Metabase não é uma lista de processos.")
    _write_json(CACHE_PATH, dataset)
    agora = _now_iso()
    set_last_refresh(agora)
    return {"totalProcessos": len(dataset), "atualizadoEm": agora}


_dataset_cache = None


def carregar_dataset(force_reload=False):
    global _dataset_cache
    if _dataset_cache is not None and not force_reload:
        return _dataset_cache
    dataset = _read_json(CACHE_PATH)
    if dataset is None:
        raise RuntimeError(
            'Nenhum dado carregado ainda. Acesse "Configurações" e clique em '
            '"Atualizar dados agora".'
        )
    _dataset_cache = dataset
    return dataset


def invalidar_cache_memoria():
    global _dataset_cache
    _dataset_cache = None


# ---------- Texto / classificação ----------

_STYLE_RE = re.compile(r"<style[\s\S]*?</style>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def strip_html(value):
    if not value:
        return ""
    sem_estilo = _STYLE_RE.sub(" ", value)
    sem_tags = _TAG_RE.sub(" ", sem_estilo)
    return _WS_RE.sub(" ", html.unescape(sem_tags)).strip()


def classificar_registro(r):
    sentenca = r.get("Teor sentenca (HTML)")
    ultima = r.get("Teor ultima decisao (HTML)")
    return {
        "temMerito": bool(sentenca),
        "temInterlocutoria": bool(ultima) and ultima != sentenca,
    }


def classificar_interlocutoria(movimento):
    texto = (movimento or "").lower()
    for rotulo, termos in REGRAS_INTERLOCUTORIA:
        if any(t in texto for t in termos):
            return rotulo
    return "Outras decisões interlocutórias"


def resumo_processo(r):
    return {
        "id": r.get("ID"),
        "processo": r.get("Processo"),
        "municipio": r.get("Municipio"),
        "zonaEleitoral": r.get("Zona Eleitoral"),
        "autor": r.get("Autor (investigante)"),
        "cargo": r.get("Cargo"),
        "eleicao": r.get("Eleicao"),
        "objeto": r.get("Objeto"),
        "resultado": r.get("Resultado"),
        "julgado": r.get("Julgado"),
        "dataDistribuicao": r.get("Data distribuicao"),
        "dataJulgamento": r.get("Data julgamento"),
        "dataUltimaDecisao": r.get("Data ultima decisao ou julgamento"),
        "movimentoUltimaDecisao": r.get("Movimento da ultima decisao ou julgamento"),
    }


# ---------- Agregações / listagens ----------

def _data_mais_recente_registro(r):
    """Maior data entre julgamento e última decisão do registro (strings ISO,
    comparáveis lexicograficamente)."""
    datas = [d for d in (r.get("Data julgamento"), r.get("Data ultima decisao ou julgamento")) if d]
    return max(datas) if datas else None


def obter_classes_disponiveis(dataset):
    return sorted({(r.get("Classe") or "").strip().upper() for r in dataset if r.get("Classe")})


def obter_ultima_decisao_indexada(dataset):
    melhor, melhor_data = None, None
    for r in dataset:
        data_r = _data_mais_recente_registro(r)
        if data_r and (melhor_data is None or data_r > melhor_data):
            melhor, melhor_data = r, data_r
    if not melhor:
        return None
    resumo = resumo_processo(melhor)
    resumo["tipo"] = "merito" if melhor_data == melhor.get("Data julgamento") else "interlocutoria"
    resumo["data"] = melhor_data
    return resumo


def obter_resumo_blocos(query=None):
    dataset = carregar_dataset()
    base = filtrar_dataset_por_query(dataset, query) if query else dataset
    merito, interlocutorias = [], []
    for r in base:
        cls = classificar_registro(r)
        if cls["temMerito"]:
            merito.append(r)
        if cls["temInterlocutoria"]:
            interlocutorias.append(r)

    categorias_merito = []
    for c in CAMPOS_CATEGORIA_MERITO:
        count = sum(1 for r in merito if r.get(c["campo"]) == "Sim")
        categorias_merito.append({"rotulo": c["rotulo"], "campo": c["campo"], "count": count})
    categorias_merito.sort(key=lambda c: -c["count"])

    resultado_counts = {}
    for r in merito:
        res = r.get("Resultado") or "Não informado"
        resultado_counts[res] = resultado_counts.get(res, 0) + 1
    resultados = sorted(
        [{"rotulo": k, "count": v} for k, v in resultado_counts.items()],
        key=lambda c: -c["count"],
    )

    interloc_counts = {}
    for r in interlocutorias:
        rotulo = classificar_interlocutoria(r.get("Movimento da ultima decisao ou julgamento"))
        interloc_counts[rotulo] = interloc_counts.get(rotulo, 0) + 1
    categorias_interlocutorias = sorted(
        [{"rotulo": k, "count": v} for k, v in interloc_counts.items()],
        key=lambda c: -c["count"],
    )

    return {
        "totalProcessos": len(dataset),
        "totalFiltrado": len(base) if query else None,
        "filtroAtivo": bool(query),
        "ultimaAtualizacao": get_last_refresh(),
        "classesDisponiveis": obter_classes_disponiveis(dataset),
        "ultimaDecisaoIndexada": obter_ultima_decisao_indexada(dataset),
        "merito": {"total": len(merito), "categorias": categorias_merito, "resultados": resultados},
        "interlocutorias": {"total": len(interlocutorias), "categorias": categorias_interlocutorias},
    }


def listar_por_categoria(bloco, campo=None, valor=None):
    dataset = carregar_dataset()
    if bloco == "merito":
        filtrados = [
            r for r in dataset
            if classificar_registro(r)["temMerito"] and (not campo or r.get(campo) == "Sim")
        ]
    else:
        def ok(r):
            cls = classificar_registro(r)
            if not cls["temInterlocutoria"]:
                return False
            if not valor:
                return True
            return classificar_interlocutoria(r.get("Movimento da ultima decisao ou julgamento")) == valor

        filtrados = [r for r in dataset if ok(r)]
    return [resumo_processo(r) for r in filtrados]


def obter_decisao(id_, tipo):
    dataset = carregar_dataset()
    registro = next((r for r in dataset if str(r.get("ID")) == str(id_)), None)
    if registro is None:
        raise ValueError(f"Processo não encontrado ou indisponível: {id_}")
    campo_html = "Teor ultima decisao (HTML)" if tipo == "interlocutoria" else "Teor sentenca (HTML)"
    return {"resumo": resumo_processo(registro), "html": registro.get(campo_html) or "", "tipo": tipo}


# ---------- Busca textual ----------

def _normalizar_texto(s):
    s = html.unescape(s or "").lower()
    nfd = unicodedata.normalize("NFD", s)
    return "".join(c for c in nfd if not unicodedata.combining(c))


def _texto_combinado(r):
    partes = [
        r.get("Objeto"), r.get("Autor (investigante)"), r.get("Municipio"),
        r.get("Zona Eleitoral"), r.get("Processo"),
        strip_html(r.get("Teor sentenca (HTML)")), strip_html(r.get("Teor ultima decisao (HTML)")),
    ]
    return _normalizar_texto(" \n ".join(p for p in partes if p))


def filtrar_dataset_por_query(dataset, query):
    """Usado tanto pela busca textual quanto pelo resumo de categorias, para
    que os cards da Início reflitam o mesmo filtro aplicado na busca."""
    query = (query or "").strip()
    if not query:
        return dataset
    termo = _normalizar_texto(query)
    return [r for r in dataset if termo in _texto_combinado(r)]


def buscar(query, bloco):
    query = (query or "").strip()
    if not query:
        return []
    dataset = carregar_dataset()
    filtrados = filtrar_dataset_por_query(dataset, query)
    resultados = []
    for r in filtrados:
        cls = classificar_registro(r)
        if bloco == "merito" and not cls["temMerito"]:
            continue
        if bloco == "interlocutorias" and not cls["temInterlocutoria"]:
            continue
        if bloco not in ("merito", "interlocutorias") and not (cls["temMerito"] or cls["temInterlocutoria"]):
            continue
        resumo = resumo_processo(r)
        resumo["temMerito"] = cls["temMerito"]
        resumo["temInterlocutoria"] = cls["temInterlocutoria"]
        resultados.append(resumo)
    return resultados[:100]
