"""
Consulta de Decisões AIJE (TRE-SC) — aplicação web local em Flask.

Rodar:
    pip install -r requirements.txt
    python app.py

Depois abra http://127.0.0.1:5000 no navegador.
"""
import truststore
# Usa o repositório de certificados do próprio SO (Windows) em vez do bundle
# padrão do Python, para confiar na CA interna do TRE-SC (mesma que o
# navegador já confia) ao acessar o Metabase interno via HTTPS.
truststore.inject_into_ssl()

from flask import Flask, jsonify, render_template, request

import data_layer
import gemini_client

app = Flask(__name__)


def erro_json(e, status=400):
    return jsonify({"erro": str(e)}), status


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/status")
def api_status():
    return jsonify({
        "possuiChaveApi": data_layer.has_api_key(),
        "ultimaAtualizacao": data_layer.get_last_refresh(),
        "totalEmbeddings": gemini_client.total_embeddings(),
    })


@app.route("/api/config/chave", methods=["POST"])
def api_salvar_chave():
    body = request.get_json(force=True, silent=True) or {}
    try:
        data_layer.save_api_key(body.get("chave"))
        return jsonify({"ok": True})
    except Exception as e:  # noqa: BLE001
        return erro_json(e)


@app.route("/api/dados/atualizar", methods=["POST"])
def api_atualizar_dados():
    try:
        res = data_layer.atualizar_dados()
        data_layer.invalidar_cache_memoria()
        return jsonify(res)
    except Exception as e:  # noqa: BLE001
        return erro_json(e, 502)


@app.route("/api/resumo")
def api_resumo():
    q = request.args.get("q") or None
    try:
        return jsonify(data_layer.obter_resumo_blocos(q))
    except Exception as e:  # noqa: BLE001
        return erro_json(e)


@app.route("/api/lista")
def api_lista():
    bloco = request.args.get("bloco", "")
    campo = request.args.get("campo") or None
    valor = request.args.get("valor") or None
    try:
        return jsonify(data_layer.listar_por_categoria(bloco, campo, valor))
    except Exception as e:  # noqa: BLE001
        return erro_json(e)


@app.route("/api/decisao")
def api_decisao():
    id_ = request.args.get("id")
    tipo = request.args.get("tipo")
    try:
        return jsonify(data_layer.obter_decisao(id_, tipo))
    except Exception as e:  # noqa: BLE001
        return erro_json(e, 404)


@app.route("/api/busca")
def api_busca():
    q = request.args.get("q", "")
    bloco = request.args.get("bloco", "todos")
    try:
        return jsonify(data_layer.buscar(q, bloco))
    except Exception as e:  # noqa: BLE001
        return erro_json(e)


@app.route("/api/embeddings/lote", methods=["POST"])
def api_gerar_lote_embeddings():
    body = request.get_json(force=True, silent=True) or {}
    tamanho = int(body.get("tamanho") or 25)
    try:
        return jsonify(gemini_client.gerar_lote_embeddings(tamanho))
    except Exception as e:  # noqa: BLE001
        return erro_json(e, 502)


@app.route("/api/similaridade", methods=["POST"])
def api_similaridade():
    arquivo = request.files.get("arquivo")
    bloco = request.form.get("bloco", "todos")
    if not arquivo or arquivo.mimetype != "application/pdf":
        return erro_json("Envie um arquivo PDF.")
    try:
        resultado = gemini_client.verificar_similaridade(arquivo.read(), bloco, top_n=10)
        return jsonify(resultado)
    except Exception as e:  # noqa: BLE001
        return erro_json(e, 502)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
