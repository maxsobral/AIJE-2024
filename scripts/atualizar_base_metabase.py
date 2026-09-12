"""
Atualização diária automática da base AIJE.

Busca a consulta do Metabase (rede interna do TRE-SC), e se o conteúdo for
diferente do cache versionado em webapp/data/aije_data_cache.json, sobrescreve
o arquivo e faz commit + push para o GitHub (de onde o Render redeploya o
site). Pensado para rodar via Tarefa Agendada do Windows, nesta máquina,
dentro da rede/VPN do TRE-SC.

Se não houver mudança nos dados, não cria commit.
"""
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import truststore

truststore.inject_into_ssl()

import requests  # noqa: E402  (precisa vir depois do inject_into_ssl)

REPO_DIR = Path(__file__).resolve().parent.parent
CACHE_PATH = REPO_DIR / "webapp" / "data" / "aije_data_cache.json"
CONFIG_PATH = REPO_DIR / "webapp" / "data" / "config.json"
LOG_PATH = Path(__file__).resolve().parent / "atualizar_base.log"

METABASE_URL = (
    "https://metabasepje.tre-sc.gov.br/public/question/"
    "cdee7e27-5c61-4a5f-8d0b-806cd4a0af58.json"
)
# Host interno à rede do TRE-SC: não deve passar pelo proxy corporativo.
NO_PROXY = {"http": None, "https": None}


def log(msg):
    linha = f"{datetime.now().isoformat(timespec='seconds')} {msg}"
    print(linha)
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(linha + "\n")


def git(*args):
    return subprocess.run(
        ["git", *args], cwd=REPO_DIR, check=True, capture_output=True, text=True
    )


def main():
    resp = requests.get(METABASE_URL, proxies=NO_PROXY, timeout=120)
    resp.raise_for_status()
    dataset = resp.json()
    if not isinstance(dataset, list) or not dataset:
        raise ValueError("Retorno do Metabase vazio ou em formato inesperado.")

    novo = json.dumps(dataset, ensure_ascii=False)
    atual = CACHE_PATH.read_text(encoding="utf-8") if CACHE_PATH.exists() else None

    if novo == atual:
        log(f"Sem mudanças ({len(dataset)} processos). Nada a commitar.")
        return

    CACHE_PATH.write_text(novo, encoding="utf-8")
    log(f"Cache atualizado: {len(dataset)} processos.")

    if CONFIG_PATH.exists():
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    else:
        cfg = {}
    cfg["ultima_atualizacao"] = datetime.now(timezone.utc).isoformat()
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")

    git("add", str(CACHE_PATH.relative_to(REPO_DIR)))
    status = git("status", "--porcelain")
    if not status.stdout.strip():
        log("git add não deixou nada staged (inesperado). Abortando sem commit.")
        return

    git(
        "commit",
        "-m",
        f"Atualização automática da base AIJE ({len(dataset)} processos)",
    )
    git("push", "origin", "master")
    log("Commit e push concluídos.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        log(f"ERRO: {type(e).__name__}: {e}")
        sys.exit(1)
