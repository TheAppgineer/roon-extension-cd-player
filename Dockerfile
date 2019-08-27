# build_hw: use 'intel-nuc' for amd64, rpi for arm32v6
ARG build_hw=intel-nuc

FROM balenalib/${build_hw}-debian:buster

RUN useradd -ms /bin/bash -G cdrom worker && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    icecast2 \
    liquidsoap \
    icedax \
    wodim \
    socat

EXPOSE 8000
WORKDIR /home/worker
ENV CDROM_GROUP=24

COPY etc /etc/
COPY cd-player.liq cd-player.js package.json /home/worker/

RUN apt-get install -y --no-install-recommends git npm nodejs && \
    npm install && \
    apt-get autoremove -y git npm && \
    chown -R worker:worker /home/worker

CMD service icecast2 start && groupmod --gid ${CDROM_GROUP} cdrom && su -c "node ." worker
