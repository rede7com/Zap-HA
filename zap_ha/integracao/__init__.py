import asyncio
import json

import aiohttp
import voluptuous as vol

from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import discovery
from homeassistant.helpers.aiohttp_client import async_get_clientsession

DOMAIN = "whatsapp"
ARQUIVO = ".zap_ha.json"

CONFIG_SCHEMA = vol.Schema({vol.Optional(DOMAIN): vol.Any(None, dict)}, extra=vol.ALLOW_EXTRA)

ALVO = vol.Any(cv.string, [cv.string])
ESQUEMAS = {
    "send_message": vol.Schema({vol.Required("target"): ALVO, vol.Required("message"): cv.string}, extra=vol.ALLOW_EXTRA),
    "send_audio": vol.Schema({vol.Required("target"): ALVO, vol.Required("url"): cv.string, vol.Optional("ptt", default=False): cv.boolean}, extra=vol.ALLOW_EXTRA),
    "send_image": vol.Schema({vol.Required("target"): ALVO, vol.Required("url"): cv.string, vol.Optional("caption"): cv.string}, extra=vol.ALLOW_EXTRA),
    "send_document": vol.Schema({vol.Required("target"): ALVO, vol.Required("url"): cv.string, vol.Optional("file_name"): cv.string, vol.Optional("mimetype"): cv.string, vol.Optional("message"): cv.string}, extra=vol.ALLOW_EXTRA),
}


def _ler(caminho):
    with open(caminho, encoding="utf-8") as arquivo:
        return json.load(arquivo)


async def chamar(hass: HomeAssistant, metodo: str, rota: str, dados=None, espera: int = 30):
    try:
        cfg = await hass.async_add_executor_job(_ler, hass.config.path(ARQUIVO))
    except (OSError, ValueError) as erro:
        raise HomeAssistantError("Zap-HA: o add-on ainda não iniciou") from erro
    try:
        async with async_get_clientsession(hass).request(
            metodo,
            cfg["url"] + rota,
            json=dados,
            headers={"X-Zap-Token": cfg["token"]},
            timeout=aiohttp.ClientTimeout(total=espera),
        ) as resposta:
            return await resposta.json(content_type=None)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as erro:
        raise HomeAssistantError("Zap-HA: o add-on não respondeu") from erro


def _corpo(servico: str, d: dict) -> dict:
    if servico == "send_message":
        return {"tipo": "texto", "texto": d["message"]}
    if servico == "send_audio":
        return {"tipo": "audio", "url": d["url"], "ptt": d["ptt"], "mimetype": d.get("mimetype", "")}
    if servico == "send_image":
        return {"tipo": "imagem", "url": d["url"], "texto": d.get("caption", "")}
    return {"tipo": "documento", "url": d["url"], "texto": d.get("message", ""), "nome": d.get("file_name", ""), "mimetype": d.get("mimetype", "")}


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    async def enviar(call: ServiceCall) -> None:
        alvos = call.data["target"]
        if isinstance(alvos, str):
            alvos = [alvos]
        for alvo in alvos:
            resposta = await chamar(hass, "POST", "/enviar", {**_corpo(call.service, call.data), "destino": alvo})
            if not resposta.get("ok"):
                raise HomeAssistantError("Zap-HA: " + str(resposta.get("erro") or "envio falhou"))

    for servico, esquema in ESQUEMAS.items():
        hass.services.async_register(DOMAIN, servico, enviar, schema=esquema)
    hass.async_create_task(discovery.async_load_platform(hass, "binary_sensor", DOMAIN, {}, config))
    return True
