#!/bin/sh
# Entrypoint do serviço mosquitto: gera o arquivo de senhas a partir do .env a
# cada start e depois executa o broker. Com exec, o mosquitto vira o PID 1 e
# recebe direto o SIGTERM do "docker compose stop".
set -eu

: "${MQTT_USER:?defina MQTT_USER no .env}"
: "${MQTT_PASSWORD:?defina MQTT_PASSWORD no .env}"

ARQUIVO_SENHAS=/mosquitto/config/passwd

# -c recria o arquivo do zero (descarta usuários antigos); -b recebe a senha como argumento.
mosquitto_passwd -c -b "$ARQUIVO_SENHAS" "$MQTT_USER" "$MQTT_PASSWORD"

# O broker roda como o usuário mosquitto. O Mosquitto 2.x reclama (e versões
# futuras recusam) de arquivo de senhas legível por outros ou com outro dono.
chown mosquitto:mosquitto "$ARQUIVO_SENHAS"
chmod 0600 "$ARQUIVO_SENHAS"

# Diretório da persistência (volume): precisa ser gravável pelo usuário mosquitto.
chown -R mosquitto:mosquitto /mosquitto/data

exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
