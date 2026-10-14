#!/bin/sh
# A primary, a replica and one sentinel in one container, all announcing 127.0.0.1, so a client
# on the host reaches the primary at the address the sentinel reports.
set -e
trap 'exit 0' TERM INT
valkey-server --port 17201 --replica-announce-ip 127.0.0.1 --save '' --appendonly no --daemonize yes
valkey-server --port 17202 --replica-announce-ip 127.0.0.1 --replicaof 127.0.0.1 17201 \
  --save '' --appendonly no --daemonize yes
mkdir -p /data/sentinel
cat > /data/sentinel/sentinel.conf <<CONF
port 17203
dir /data/sentinel
sentinel announce-ip 127.0.0.1
sentinel monitor nvk 127.0.0.1 17201 1
sentinel down-after-milliseconds nvk 3000
sentinel failover-timeout nvk 10000
CONF
valkey-server /data/sentinel/sentinel.conf --sentinel --daemonize yes
tail -f /dev/null &
wait
