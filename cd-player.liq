#!/usr/bin/liquidsoap

# setup server socket
set("server.socket",true)
set("server.socket.path","liquidsoap.sock")

# setup logging to stdout
set("log.file",false)
set("log.stdout",true)
set("log.unix_timestamps",true)

# input from socket
s = input.external("socat UNIX-LISTEN:cd-player.sock,fork -", buffer=1.0)
s = server.insert_metadata(id="metadata", s)

# stream it to local icecast, default port and password
output.icecast(%ogg(%flac(samplerate=44100,channels=2,compression=5,bits_per_sample=16)),
  mount='/roon-extension-cd-player', name='CD Player', format='audio/ogg',
  description='Extension that adds a CD player to your Roon system',
  host='127.0.0.1',
  genre='Misc', start=false, fallible=true, s)
