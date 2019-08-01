FROM phasecorex/liquidsoap

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
    icecast2 \
    icedax \
    git \
    nodejs \
    npm \
    socat \
    wodim \
    nano

EXPOSE 8000
WORKDIR /root

COPY etc /etc/
COPY cd-player.liq cd-player.js package.json /root/

RUN mv /liquidsoap /usr/local/bin/ && npm install

# Override entrypoint of base image
ENTRYPOINT ["/usr/bin/env"]

CMD service icecast2 start && node .
