// Copyright 2019 The Appgineer
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

const ACTION_PLAY = 1;
const ACTION_STOP = 2;

const SELF       = 'player';
const LIQUIDSOAP = 'Liquid';
const ICEDAX     = 'icedax';
const SOCAT      = ' socat';
const WODIM      = ' wodim';

const STDOUT     = 'stdout';
const STDERR     = 'stderr';

const child_process = require('child_process');

var RoonApi          = require("node-roon-api"),
    RoonApiSettings  = require('node-roon-api-settings'),
    RoonApiStatus    = require('node-roon-api-status'),
    RoonApiTransport = require('node-roon-api-transport'),
    RoonApiBrowse    = require('node-roon-api-browse');

var core = undefined;
var cd_player = undefined;
var mountpoint_cbs = undefined;
var track_timer = undefined;
var terminate = false;
var timestamps = {};

var roon = new RoonApi({
    extension_id:        'com.theappgineer.cd-player',
    display_name:        'CD Player',
    display_version:     '0.1.0',
    publisher:           'The Appgineer',
    email:               'theappgineer@google.com',

    core_paired: function(core_) {
        core = core_;
    },
    core_unpaired: function(core_) {
        core = undefined;
    }
});

var my_settings = roon.load_config("settings") || {
};

var svc_settings = new RoonApiSettings(roon, {
    get_settings: function(cb) {
        cb(makelayout(my_settings));
    },
    save_settings: function(req, isdryrun, settings) {
        let l = makelayout(settings.values);
        req.send_complete(l.has_error ? "NotValid" : "Success", { settings: l });

        if (!isdryrun && !l.has_error) {
            perform_action(l.values);
            delete l.values.action;
            delete l.values.from;

            my_settings = l.values;
            svc_settings.update_settings(l);
            roon.save_config("settings", my_settings);
        }
    }
});

var svc_status = new RoonApiStatus(roon);

function makelayout(settings) {
    let l = {
        values:    settings,
        layout:    [],
        has_error: false
    };
    let actions = {
        type:    "dropdown",
        title:   "Action",
        values: [
            { title: "(select action)", value: undefined }
        ],
        setting: "action"
    };

    l.layout.push({
        type:    "zone",
        title:   "Auto-Tune Zone",
        setting: "zone"
    });

    if (cd_player) {
        actions.values.push({ title: "Stop", value: ACTION_STOP });
    } else {
        actions.values.push({ title: "Play", value: ACTION_PLAY });
    }

    l.layout.push(actions);

    if (settings.action == ACTION_PLAY) {
        const start_track = {
            type:    "integer",
            min:     1,
            title:   "Start at Track",
            setting: "from"
        };

        if (settings.from === undefined) {
            settings.from = '1';
        }

        if (settings.from < start_track.min) {
            start_track.error = `The start track should be ${start_track.min} or higher`;
            l.has_error = true;
        }

        l.layout.push(start_track);
    }

    return l;
}

function perform_action(settings) {
    let start_track = parseInt(settings.from);      // Backup setting for callback

    switch (settings.action) {
        case ACTION_PLAY:
            query_cd((metadata) => {
                let track_range;

                // Input clipping
                if (start_track > metadata.total_tracks) {
                    start_track = metadata.total_tracks;
                } else if (start_track < 1) {
                    start_track = 1;
                }

                if (start_track == metadata.total_tracks) {
                    track_range = `${start_track}`;
                } else {
                    track_range = `${start_track}+${metadata.total_tracks}`;
                }

                play_cd(metadata, track_range, {
                    playback_started: function(stream_delay) {
                        auto_tune(settings.zone);
                        track_track(metadata, start_track - 1, stream_delay);
                    },
                    playback_stopped: function() {
                        auto_stop(settings.zone);
                    }
                });
            });
            break;
        case ACTION_STOP:
            if (cd_player) {
                // Killing the process will trigger the other actions
                process.kill(-cd_player.pid);
            }
            break;
    }
}

function query_cd(cb) {
    // Use wodim with -toc option to get the number of tracks
    // Closes tray in the process, if necessary
    const child = child_process.spawn('wodim', ['dev=/dev/cdrom', '-toc']);
    let metadata = {};

    child.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');

        for (let i = 0; i < lines.length; i++) {
            const fields = lines[i].split(': ');

            log(WODIM, STDOUT, i, lines[i]);

            switch (fields[0]) {
                case 'wodim':
                    if (fields[1] == 'No disk / Wrong disk!') {
                        svc_status.set_status('Please insert a CD in the drive', true);
                    }
                    break;
                case 'first':
                    metadata.total_tracks = parseInt(fields[1].split(' ')[2]);
                    break;
            }
        }
    });

    child.on('close', (code, signal) => {
        if (metadata.total_tracks) {
            cb && cb(metadata);
        }
    });
}

function play_cd(metadata, track_range, cbs) {
    const options = ['dev=/dev/cdrom',
                     'output-format=raw',
                     'output-endianess=little',
                     'speed=1',
                     '-gui',
                     'cddb=1',
                     'track=' + track_range,
                     '-',
                     '|',
                     'socat',
                     '-',
                     'UNIX:/var/run/cd-player.sock'];
    let stream_delay = Date.now();
    let partial_line;

    mountpoint_cbs = {
        on_connect: function() {
            stream_delay = Date.now() - stream_delay;

            log(SELF, STDOUT, false, 'Streaming Delay:', stream_delay);
            log(SELF, STDOUT, false, metadata);

            cbs && cbs.playback_started && cbs.playback_started(stream_delay);
        },
        on_disconnect: function() {
            cbs && cbs.playback_stopped && cbs.playback_stopped();
        }
    };

    cd_player = child_process.spawn('icedax', options, { shell: '/bin/bash', detached: true });

    cd_player.stderr.on('data', (data) => {
        const lines = data.toString().trim().split('\n');

        for (let i = 0; i < lines.length; i++) {
            const fields = lines[i].split(':');

            log(ICEDAX, STDERR, i, lines[i]);

            switch (fields[0]) {
                case 'Album title':
                    parse_artist_album(fields.slice(1).join(':'), metadata);

                    svc_status.set_status(`Playing ${metadata.album} by ${metadata.artist}`, false);
                    break;
                default:
                    if (metadata.album && (fields[0].indexOf('T') == 0 || partial_line !== undefined)) {
                        if (partial_line === undefined) {
                            partial_line = parse_track(undefined, fields.slice(1).join(':'), metadata);
                        } else {
                            partial_line = parse_track(partial_line, lines[i], metadata);
                        }

                        if (metadata.tracks && metadata.tracks.length == metadata.total_tracks) {
                            // Send the CD_Player.start command, this will trigger the on_connect callback
                            // There is no CD_Player.stop counterpart because the fallible Liquidsoap output
                            // will switch to 'off' when the connection is closed
                            send_liquidsoap_command('CD_Player.start');
                        }
                    }
                    break;
            }
        }
    });

    cd_player.on('close', (code, signal) => {
        if (signal) {
            log(ICEDAX, STDOUT, false, 'Exited with signal:', signal);

            if (terminate) {
                process.exit(0);
            } else {
                // This is a stop requested by the user
                cbs && cbs.playback_stopped && cbs.playback_stopped();

                // Unregister callbacks
                mountpoint_cbs = undefined;
            }
        } else {
            log(ICEDAX, STDOUT, false, 'Exited with code:', code);
        }

        cd_player = undefined;
    });
}

function parse_artist_album(line, metadata) {
    // Example: 'Wicked Game (MCD 1990)' from 'Various Artists'
    const fields = line.split("'");
    const escaped = get_escaped_string(fields, 1);

    metadata.album = escaped.string;
    metadata.artist = get_escaped_string(fields, escaped.next_index + 1).string;
}

function parse_track(partial_line, line, metadata) {
    // Example:      33  4:06.65 audio linear copydenied stereo title 'Chris Isaak / Wicked Game' from ''
    if (partial_line) {
        line = partial_line + ' ' + line;
    }

    let fields = line.split("'");

    if (fields.length > 2) {    // Make sure we have the complete title
        let track = {};

        if (!metadata.tracks) {
            metadata.tracks = [];
        }

        track.title = get_escaped_string(fields, 1).string;

        fields = fields[0].trim().split(' ');

        track.duration = get_duration(fields[1] == '' ? fields[2] : fields[1]);

        metadata.tracks.push(track);

        return undefined;
    } else {
        // Continue when the remainder of the line gets in at the next call
        return line;
    }
}

function get_escaped_string(fields, start_index) {
    let string = fields[start_index];
    let i;

    for (i = start_index + 1; i < fields.length && string.lastIndexOf('\\') == string.length - 1; i++) {
        string = string.slice(0, -1) + "'" + fields[i];
    }

    return {
        string:     string,
        next_index: i
    };
}

function get_duration(duration_string) {
    let fields = duration_string.split('.');
    let duration = undefined;

    if (fields.length > 1) {
        duration = parseInt(fields[1]) * 10;

        fields = fields[0].split(':');

        if (fields.length == 2) {
            duration += parseInt(fields[0]) * 60000 + parseInt(fields[1]) * 1000;
        }
    }

    return duration;
}

function send_liquidsoap_command(command, cb) {
    const options = [command, '|', 'socat', '-', 'UNIX:/var/run/liquidsoap.sock'];
    const child = child_process.spawn('echo', options, { shell: '/bin/bash' });

    child.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');

        for (let i = 0; i < lines.length; i++) {
            log(SOCAT, STDOUT, i, lines[i]);

            switch(lines[i].trim()) {
                case 'OK':
                    cb && cb();
                    break;
            }
        }
    });
}

function auto_tune(zone) {
    if (zone) {
        refresh_browse({ pop_all: true }, [ 'Internet Radio', 'CD Player' ], (item, done) => {
            if (item) {
                refresh_browse({
                    hierarchy:         "browse",
                    zone_or_output_id: zone.output_id,
                    item_key:          item.item_key
                });
            } else if (done) {
                // Report error if CD PLayer stream is not found
                svc_status.set_status('Please add Internet Radio station for URL:\n' +
                                      `http://${get_ip()}:8000/roon-extension-cd-player`, true);
            }
        });
    }
}

function get_ip() {
    const os = require('os');
    let ifaces = os.networkInterfaces();

    for (const ifname in ifaces) {
        ifaces[ifname].forEach(function (iface) {
            if (iface.family == 'IPv4' && !iface.internal) {
                return iface.address;
            }
        });
    }

    return undefined;
}

function track_track(metadata, track_index, offset) {
    let duration = metadata.tracks[track_index].duration;
    let status_string = `Playing ${metadata.album} by ${metadata.artist}`;

    if (duration) {
        if (offset) {
            duration += offset;
        }

        if (track_index + 1 < metadata.total_tracks) {
            track_timer = setTimeout(track_track, duration, metadata, track_index + 1);
        }

        status_string += `\n${track_index + 1}: ${metadata.tracks[track_index].title}`;
    }

    svc_status.set_status(status_string);
}

function auto_stop(zone) {
    if (zone) {
        core.services.RoonApiTransport.control(zone, 'stop');
    }

    if (track_timer) {
        clearTimeout(track_timer);
        track_timer = undefined;
    }

    svc_status.set_status('Playback stopped', false);
}

function refresh_browse(opts, path, cb) {
    opts = Object.assign({ hierarchy: "browse" }, opts);

    core.services.RoonApiBrowse.browse(opts, (err, r) => {
        if (err == false) {
            if (r.action == "list") {
                let list_offset = (r.list.display_offset > 0 ? r.list.display_offset : 0);

                load_browse(list_offset, path, cb);
            }
        }
    });
}

function load_browse(list_offset, path, cb) {
    let opts = {
        hierarchy:          "browse",
        offset:             list_offset,
        set_display_offset: list_offset
    };

    core.services.RoonApiBrowse.load(opts, (err, r) => {
        if (err == false && path) {
            if (!r.list.level ||                                // Top level
                    !path[r.list.level - 1] ||                  // No Previous path element specified
                    r.list.title == path[r.list.level - 1]) {   // Previous path element match
                if (r.items.length) {                           // Entries available
                    for (let i = 0; i < r.items.length; i++) {
                        const match = (r.items[i].title == path[r.list.level]);   // Path element match

                        if (!path[r.list.level] || match) {
                            if (r.list.level < path.length - 1) {
                                refresh_browse({ item_key: r.items[i].item_key }, path, cb);
                                break;
                            } else {
                                const done = (match || i + 1 == r.items.length);

                                cb && cb(r.items[i], done);

                                if (done) {
                                    break;
                                }
                            }
                        } else if (path[r.list.level] &&            // Path element specfied
                                r.list.level == path.length - 1 &&  // Last path element
                                i == r.items.length - 1) {          // No match found within items
                            cb && cb(undefined, true);
                        }
                    }
                } else if (cb) {
                    cb(undefined, true);
                }
            }
        }
    });
}

function init() {
    process.on('SIGTERM', listener);
    process.on('SIGINT', listener);

    run_liquidsoap();

    roon.start_discovery();
}

function listener() {
    if (cd_player) {
        process.kill(-cd_player.pid);
        terminate = true;
    } else {
        process.exit(0);
    }
}

function run_liquidsoap() {
    const fs = require('fs');

    // Remove socket
    try {
        fs.unlinkSync('/var/run/cd-player.sock');
    } catch (err) {
        // All fine
    }

    const liquidsoap = child_process.spawn('./cd-player.liq');

    liquidsoap.stdout.on('data', (data) => {
        const lines = data.toString().trim().split('\n');

        for (let i = 0; i < lines.length; i++) {
            const fields = lines[i].split('] ');

            log(LIQUIDSOAP, STDOUT, i, lines[i].split(' ').slice(1).join(' '));   // Drop timestamp

            if (fields.length > 1) {
                const process_id = fields[0].split(' [')[1];
                const message = fields[1];

                if (process_id.includes('CD_Player')) {
                    switch (message) {
                        case 'Connection setup was successful.':
                            mountpoint_cbs && mountpoint_cbs.on_connect && mountpoint_cbs.on_connect();
                            break;
                        case 'Closing connection...':
                            mountpoint_cbs && mountpoint_cbs.on_disconnect && mountpoint_cbs.on_disconnect();
                            break;
                    }
                }
            }
        }
    });
}

function log(process_id, stdio, is_followup, ...args) {
    const date = new Date();
    const timestamp = date.toISOString();
    const id = `${process_id}-${stdio}`;
    let header;

    if (is_followup) {
        header = `${timestamps[id]} ${id}:`;     // Repeat timestamp for multi-line logs
    } else {
        timestamps[id] = timestamp;
        header = `${timestamp} ${id}:`;
    }

    if (stdio == STDERR) {
        console.error(header, ...args);
    } else {
        console.log(header, ...args);
    }
}

roon.init_services({
    required_services:   [ RoonApiTransport, RoonApiBrowse ],
    provided_services:   [ svc_settings, svc_status ]
});

init();
