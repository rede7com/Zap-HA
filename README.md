# Zap-HA

Add-on do Home Assistant que liga o WhatsApp ao HA usando Baileys, sem navegador.

## O que faz

O painel do add-on mostra o QR code para parear ou gera o código de pareamento a partir do número. A sessão fica guardada em `/data` e a reconexão é automática. Todo envio entra numa fila gravada em disco, é reenviado com o mesmo id quando o servidor do WhatsApp não confirma em 30 segundos e, depois de três tentativas, dispara o evento `whatsapp_message_failed`.

Ao iniciar, o add-on copia a integração `whatsapp` para `custom_components`, acrescenta `whatsapp:` ao `configuration.yaml` e pede um reinício do Home Assistant.

## Serviços

`whatsapp.send_message` (target, message), `whatsapp.send_audio` (target, url, ptt), `whatsapp.send_image` (target, url, caption) e `whatsapp.send_document` (target, url, file_name, mimetype, message). O destino é um número com DDI e DDD ou o id de um grupo.

## Eventos e sensor

`whatsapp_message_received` traz content, from, sender, sender_number, sender_name, is_group, media_url, media_type, caption, raw e session_id. A mídia recebida fica em `http://<ha>:8066/media/<arquivo>` por sete dias. `whatsapp_message_sent` confirma cada envio aceito pelo servidor. O `binary_sensor.whatsapp_<numero>` indica se a conexão está de pé.

## Instalação

Em Configurações, Add-ons, Loja, Repositórios, acrescente `https://github.com/rede7com/Zap-HA`, instale o Zap-HA, inicie, abra o painel e pareie. Reinicie o Home Assistant quando o painel pedir.
