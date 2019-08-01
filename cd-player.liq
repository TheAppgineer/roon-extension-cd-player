#!/usr/local/bin/liquidsoap

# allow_root requires version 1.3.4
set("init.allow_root",true)

# setup server socket
set("server.socket",true)
set("server.socket.path","/var/run/liquidsoap.sock")

# setup logging to stdout
set("log.file",false)
set("log.stdout",true)
set("log.unix_timestamps",true)

# input from socket
s = input.external("socat UNIX-LISTEN:/var/run/cd-player.sock,fork -", buffer=1.0)
s = server.insert_metadata(id="metadata", s)

# stream it to local icecast, default port and password
output.icecast(%ogg(%flac(samplerate=44100,channels=2,compression=5,bits_per_sample=16)),
  mount='/roon-extension-cd-player', name='CD Player', format='audio/ogg',
  description='Extension that adds a CD player to your Roon system',
  genre ='Misc', start=false, fallible=true, s)
#output.icecast(%mp3(bitrate=256), mount="/roon-extension-cd-player", s)
