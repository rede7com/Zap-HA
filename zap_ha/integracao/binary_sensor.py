import asyncio
from datetime import timedelta

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.exceptions import HomeAssistantError

from . import chamar

SCAN_INTERVAL = timedelta(seconds=30)


async def async_setup_platform(hass, config, async_add_entities, discovery_info=None):
    async def esperar_numero():
        while True:
            try:
                situacao = await chamar(hass, "GET", "/status", espera=10)
                if situacao.get("numero"):
                    async_add_entities([Conexao(situacao)])
                    return
            except HomeAssistantError:
                pass
            await asyncio.sleep(30)

    hass.async_create_background_task(esperar_numero(), "zap_ha_numero")


class Conexao(BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_icon = "mdi:whatsapp"

    def __init__(self, situacao):
        numero = situacao["numero"]
        self._attr_name = "WhatsApp " + numero
        self._attr_unique_id = "zap_ha_" + numero
        self.entity_id = "binary_sensor.whatsapp_" + numero
        self._aplicar(situacao)

    def _aplicar(self, situacao):
        self._attr_is_on = bool(situacao.get("conectado"))
        self._attr_extra_state_attributes = {"estado": situacao.get("estado"), "fila": situacao.get("fila"), "versao": situacao.get("versao")}

    async def async_update(self):
        try:
            self._aplicar(await chamar(self.hass, "GET", "/status", espera=10))
        except HomeAssistantError:
            self._aplicar({"estado": "add-on sem resposta"})
