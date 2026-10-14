#!/bin/sh
# Six valkey-server processes in one container: three primaries, three replicas. Each announces
# 127.0.0.1 and listens on the same port inside and outside the container, so a client on the
# host follows the cluster's redirects without any address mapping. The bus ports stay inside.
set -e
trap 'exit 0' TERM INT
for port in 17101 17102 17103 17104 17105 17106; do
  mkdir -p "/data/$port"
  valkey-server --port "$port" --cluster-enabled yes --cluster-config-file "/data/$port/nodes.conf" \
    --dir "/data/$port" --cluster-announce-ip 127.0.0.1 --cluster-node-timeout 3000 \
    --save '' --appendonly no --daemonize yes
done
for port in 17101 17102 17103 17104 17105 17106; do
  until valkey-cli -p "$port" ping >/dev/null 2>&1; do sleep 0.1; done
done
valkey-cli --cluster create 127.0.0.1:17101 127.0.0.1:17102 127.0.0.1:17103 \
  127.0.0.1:17104 127.0.0.1:17105 127.0.0.1:17106 --cluster-replicas 1 --cluster-yes
tail -f /dev/null &
wait
