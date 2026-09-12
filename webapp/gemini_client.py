"""
Integração com o Gemini: leitura de PDF, geração de embeddings da base e
verificação de similaridade. As chamadas ao Gemini são externas (internet),
então passam pelo proxy corporativo — diferente da busca ao Metabase, que é
interna e não usa proxy (ver data_layer.NO_PROXY).
"""
import base64
import json
import math
import os
import re
import threading
import time
from urllib.parse import quote

import requests

from data_layer import (
    CACHE_PATH,
    DATA_DIR,
    EMBEDDINGS_PATH,
    classificar_registro,
    carregar_dataset,
    get_api_key,
    has_api_key,
    resumo_processo,
    strip_html,
    _read_json,
    _write_json,
)

GEMINI_MODEL_GENERATIVO = "gemini-3.8-flash"
GEMINI_MODEL_EMBEDDING = "gemini-embedding-001"
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/"

# ---------- Indexação automática em segundo plano ----------
#
# Em vez de depender de alguém ficar clicando em "Gerar mais um lote", um
# thread em segundo plano vai gerando os embeddings pendentes sozinho, aos
# poucos, sempre que houver processos novos (após "Atualizar dados agora" ou
# ao iniciar o servidor). O progresso fica disponível via status_indexacao(),
# consultado pelo front-end para mostrar o aviso de "base em atualização".

LOTE_BACKGROUND = 8
PAUSA_ENTRE_LOTES_SEG = 3
MAX_TENTATIVAS_POR_ITEM = 3

# Lock em arquivo (não só em memória) porque em produção o gunicorn roda mais
# de um worker (processos separados) e só um deles deve indexar por vez.
_LOCK_PATH = os.path.join(DATA_DIR, "indexacao.lock")
_LOCK_STALE_SEG = 30 * 60

_thread_lock = threading.Lock()
_thread_ativa = False


def _encode_proxy_url(raw):
    """Corrige URLs de proxy corporativo cujo usuário/senha tenham
    caracteres reservados (@, :) não codificados, que quebram o parser de
    proxy de bibliotecas HTTP."""
    if not raw:
        return None
    m = re.match(r"^(https?://)(.*)$", raw)
    if not m:
        return raw
    scheme, rest = m.group(1), m.group(2)
    if "@" not in rest:
        return raw
    userinfo, hostport = rest.rsplit("@", 1)
    if ":" in userinfo:
        user, pwd = userinfo.split(":", 1)
        userinfo = f"{quote(user, safe='')}:{quote(pwd, safe='')}"
    return f"{scheme}{userinfo}@{hostport}"


def _external_proxies():
    https_proxy = _encode_proxy_url(os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY"))
    http_proxy = _encode_proxy_url(os.environ.get("http_proxy") or os.environ.get("HTTP_PROXY"))
    proxies = {}
    if https_proxy:
        proxies["https"] = https_proxy
    if http_proxy:
        proxies["http"] = http_proxy
    return proxies or None


def _post_gemini(path, payload, timeout=120):
    api_key = get_api_key()
    url = f"{GEMINI_API_BASE}{path}?key={api_key}"
    resp = requests.post(
        url, json=payload, proxies=_external_proxies(), timeout=timeout
    )
    try:
        body = resp.json()
    except ValueError:
        resp.raise_for_status()
        raise RuntimeError("Resposta inesperada do Gemini.")
    if resp.status_code != 200:
        msg = (body.get("error") or {}).get("message") or resp.text
        raise RuntimeError(f"Erro Gemini ({resp.status_code}): {msg}")
    return body


def extrair_texto_pdf(pdf_bytes):
    base64_pdf = base64.b64encode(pdf_bytes).decode("ascii")
    parts = [
        {
            "text": (
                "Extraia o conteúdo textual relevante desta peça jurídica eleitoral "
                "(petição, recurso, defesa, decisão etc.), preservando os principais "
                "fatos, fundamentos jurídicos e pedidos. Responda apenas com o texto "
                "extraído/resumido, em português, sem comentários adicionais, em até "
                "6000 caracteres."
            )
        },
        {"inlineData": {"mimeType": "application/pdf", "data": base64_pdf}},
    ]
    body = _post_gemini(f"{GEMINI_MODEL_GENERATIVO}:generateContent", {"contents": [{"parts": parts}]})
    candidatos = body.get("candidates") or []
    if not candidatos:
        raise RuntimeError("Não foi possível extrair texto do PDF enviado.")
    partes = (candidatos[0].get("content") or {}).get("parts") or []
    texto = "\n".join(p.get("text", "") for p in partes).strip()
    if not texto:
        raise RuntimeError("Não foi possível extrair texto do PDF enviado.")
    return texto


def gerar_embedding(texto):
    payload = {
        "model": f"models/{GEMINI_MODEL_EMBEDDING}",
        "content": {"parts": [{"text": texto}]},
    }
    body = _post_gemini(f"{GEMINI_MODEL_EMBEDDING}:embedContent", payload)
    return body["embedding"]["values"]


def truncar_para_embedding(texto, max_chars=8000):
    if not texto:
        return ""
    return texto[:max_chars]


def similaridade_cosseno(a, b):
    n = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(a[i] * a[i] for i in range(n)))
    nb = math.sqrt(sum(b[i] * b[i] for i in range(n)))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _chaves_necessarias(dataset):
    """Toda chave (id_tipo) que deveria ter um embedding, com o texto de origem."""
    for r in dataset:
        cls = classificar_registro(r)
        id_ = str(r.get("ID"))
        if cls["temMerito"]:
            yield f"{id_}_merito", id_, "merito", strip_html(r.get("Teor sentenca (HTML)"))
        if cls["temInterlocutoria"]:
            yield f"{id_}_interlocutoria", id_, "interlocutoria", strip_html(r.get("Teor ultima decisao (HTML)"))


def _pendentes(dataset, store):
    """Chaves sem embedding ainda, ou com erro e menos de MAX_TENTATIVAS_POR_ITEM
    tentativas (evita martelar a API indefinidamente num item permanentemente
    problemático)."""
    pendentes = []
    for chave, id_, tipo, texto in _chaves_necessarias(dataset):
        entrada = store.get(chave)
        if entrada is None:
            pendentes.append((chave, id_, tipo, texto))
        elif entrada.get("error") and entrada.get("tentativas", 1) < MAX_TENTATIVAS_POR_ITEM:
            pendentes.append((chave, id_, tipo, texto))
    return pendentes


def _processar_lote(pendentes, store):
    processados = 0
    for chave, id_, tipo, texto in pendentes:
        try:
            vetor = gerar_embedding(truncar_para_embedding(texto))
            store[chave] = {"id": id_, "tipo": tipo, "vector": vetor}
            processados += 1
        except Exception as e:  # noqa: BLE001 - registra e segue para o próximo
            tentativas = (store.get(chave) or {}).get("tentativas", 0) + 1
            store[chave] = {"id": id_, "tipo": tipo, "error": str(e), "tentativas": tentativas}
    return processados


def gerar_lote_embeddings(tamanho_lote=25):
    """Gera um lote sob demanda (mantido para uso manual/depuração). O fluxo
    normal é a indexação em segundo plano, ver iniciar_indexacao_background."""
    dataset = carregar_dataset()
    store = _read_json(EMBEDDINGS_PATH, {}) or {}
    pendentes = _pendentes(dataset, store)
    lote = pendentes[:tamanho_lote]
    processados = _processar_lote(lote, store)
    _write_json(EMBEDDINGS_PATH, store)
    return {
        "processadosAgora": processados,
        "restantes": len(pendentes) - processados,
        "totalPendenteAntes": len(pendentes),
        "totalArmazenado": total_embeddings(),
    }


def total_embeddings():
    store = _read_json(EMBEDDINGS_PATH, {}) or {}
    return sum(1 for v in store.values() if v.get("vector"))


def status_indexacao():
    """Progresso da indexação para exibir ao usuário final (ver /api/status)."""
    try:
        dataset = carregar_dataset()
    except RuntimeError:
        return {"totalNecessario": 0, "totalIndexado": 0, "restantes": 0, "percentual": 100, "emAndamento": False}
    store = _read_json(EMBEDDINGS_PATH, {}) or {}
    total_necessario = sum(1 for _ in _chaves_necessarias(dataset))
    indexados = sum(1 for v in store.values() if v.get("vector"))
    restantes = len(_pendentes(dataset, store))
    percentual = 100 if total_necessario == 0 else round(indexados * 100 / total_necessario)
    return {
        "totalNecessario": total_necessario,
        "totalIndexado": indexados,
        "restantes": restantes,
        "percentual": percentual,
        "emAndamento": _thread_ativa or _lock_ativo(),
    }


def _lock_ativo():
    """Indica indexação em andamento neste processo ou em outro worker (o
    lock é em arquivo justamente para ser visível entre processos)."""
    try:
        idade = time.time() - os.path.getmtime(_LOCK_PATH)
    except OSError:
        return False
    return idade <= _LOCK_STALE_SEG


def _adquirir_lock_indexacao():
    try:
        fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode())
        os.close(fd)
        return True
    except FileExistsError:
        try:
            idade = time.time() - os.path.getmtime(_LOCK_PATH)
        except OSError:
            return False
        if idade > _LOCK_STALE_SEG:
            # Lock órfão (processo anterior morreu sem liberar) — assume e segue.
            try:
                os.remove(_LOCK_PATH)
            except OSError:
                pass
        return False


def _liberar_lock_indexacao():
    try:
        os.remove(_LOCK_PATH)
    except OSError:
        pass


def _loop_indexacao_background():
    global _thread_ativa
    try:
        try:
            dataset = carregar_dataset(force_reload=True)
        except RuntimeError:
            return
        while True:
            store = _read_json(EMBEDDINGS_PATH, {}) or {}
            pendentes = _pendentes(dataset, store)
            if not pendentes:
                break
            _processar_lote(pendentes[:LOTE_BACKGROUND], store)
            _write_json(EMBEDDINGS_PATH, store)
            time.sleep(PAUSA_ENTRE_LOTES_SEG)
    finally:
        _thread_ativa = False
        _liberar_lock_indexacao()


def iniciar_indexacao_background():
    """Dispara (se ainda não estiver rodando) o preenchimento gradual dos
    embeddings pendentes, sem exigir clique nenhum. Chamado ao iniciar o
    servidor e depois de cada atualização de dados bem-sucedida."""
    global _thread_ativa
    with _thread_lock:
        if _thread_ativa or not has_api_key():
            return False
        if not _adquirir_lock_indexacao():
            return False
        _thread_ativa = True
        threading.Thread(target=_loop_indexacao_background, daemon=True).start()
        return True


def _extrair_json(texto):
    texto = texto.strip()
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", texto)
    if m:
        texto = m.group(1).strip()
    return json.loads(texto)


def explicar_trechos_relevantes(texto_consulta, candidatos):
    """Pede ao Gemini, num único lote, o trecho de cada julgado candidato que
    mais evidencia a semelhança com a peça enviada, para destacar no resultado.
    Retorna um dict {indice: {"trecho": ..., "motivo": ...}}."""
    if not candidatos:
        return {}
    blocos_candidatos = "\n\n".join(
        f"### Julgado {c['indice']} ({c['processo']})\n{c['texto']}" for c in candidatos
    )
    prompt = (
        "Você é um assistente jurídico eleitoral. Abaixo está o texto de uma peça "
        "enviada por um usuário, seguido de trechos de julgados candidatos a "
        "precedentes semelhantes.\n\n"
        f"PEÇA ENVIADA:\n{texto_consulta}\n\n"
        f"JULGADOS CANDIDATOS:\n{blocos_candidatos}\n\n"
        "Para CADA julgado candidato, identifique o trecho mais relevante (copiado "
        "literalmente do texto do julgado, entre 1 e 3 frases, no máximo 350 "
        "caracteres) que evidencia a semelhança com a peça enviada, e escreva uma "
        "frase curta (até 20 palavras) explicando o motivo da semelhança.\n\n"
        "Responda APENAS com um JSON no formato "
        '[{"indice": 0, "trecho": "...", "motivo": "..."}, ...], um item para cada '
        "julgado candidato, na mesma ordem, sem comentários adicionais."
    )
    body = _post_gemini(
        f"{GEMINI_MODEL_GENERATIVO}:generateContent",
        {"contents": [{"parts": [{"text": prompt}]}]},
    )
    candidatas_resp = body.get("candidates") or []
    if not candidatas_resp:
        return {}
    partes = (candidatas_resp[0].get("content") or {}).get("parts") or []
    texto_resp = "\n".join(p.get("text", "") for p in partes).strip()
    try:
        itens = _extrair_json(texto_resp)
    except (ValueError, TypeError):
        return {}
    if not isinstance(itens, list):
        return {}
    resultado = {}
    for item in itens:
        try:
            idx = int(item.get("indice"))
        except (TypeError, ValueError, AttributeError):
            continue
        resultado[idx] = {
            "trecho": (item.get("trecho") or "").strip(),
            "motivo": (item.get("motivo") or "").strip(),
        }
    return resultado


def verificar_similaridade(pdf_bytes, bloco, top_n=10):
    texto_extraido = extrair_texto_pdf(pdf_bytes)
    texto_considerado = truncar_para_embedding(texto_extraido)
    vetor_consulta = gerar_embedding(texto_considerado)

    store = _read_json(EMBEDDINGS_PATH, {}) or {}
    if not store:
        raise RuntimeError(
            'Nenhum embedding gerado ainda. Acesse "Configurações" e gere os '
            "embeddings da base primeiro."
        )

    dataset = carregar_dataset()
    por_id = {str(r.get("ID")): r for r in dataset}

    tipo_filtro = {"merito": "merito", "interlocutorias": "interlocutoria"}.get(bloco)

    pontuados = []
    for entrada in store.values():
        if not entrada.get("vector"):
            continue
        if tipo_filtro and entrada.get("tipo") != tipo_filtro:
            continue
        registro = por_id.get(str(entrada.get("id")))
        if not registro:
            continue
        score = similaridade_cosseno(vetor_consulta, entrada["vector"])
        pontuados.append({
            "score": score,
            "tipo": entrada["tipo"],
            "resumo": resumo_processo(registro),
            "_registro": registro,
        })

    pontuados.sort(key=lambda p: -p["score"])
    top = pontuados[:top_n]

    candidatos = []
    for i, p in enumerate(top):
        campo = "Teor ultima decisao (HTML)" if p["tipo"] == "interlocutoria" else "Teor sentenca (HTML)"
        texto = truncar_para_embedding(strip_html(p["_registro"].get(campo)), max_chars=4000)
        candidatos.append({
            "indice": i,
            "processo": p["resumo"].get("processo") or p["resumo"].get("id"),
            "texto": texto,
        })
        del p["_registro"]

    try:
        explicacoes = explicar_trechos_relevantes(texto_considerado, candidatos)
    except Exception:  # noqa: BLE001 - destaque é complementar; falha não derruba a busca
        explicacoes = {}

    for i, p in enumerate(top):
        info = explicacoes.get(i) or {}
        p["trechoRelevante"] = info.get("trecho") or ""
        p["motivoRelevancia"] = info.get("motivo") or ""

    return {
        "textoExtraido": texto_extraido,
        "textoConsiderado": texto_considerado,
        "truncado": len(texto_extraido) > len(texto_considerado),
        "resultados": top,
    }
