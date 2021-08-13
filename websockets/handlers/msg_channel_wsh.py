#!/usr/bin/python
import json
import logging
import urllib
import threading
import traceback
from queue import Empty

from mod_pywebsocket import stream, msgutil
from wptserve import stash

logger = logging.getLogger()

address, authkey = stash.load_env_config()
stash = stash.Stash("msg_channel", address=address, authkey=authkey)


def log(uuid, msg):
    logger.debug(f"{uuid}: {msg}")


def web_socket_do_extra_handshake(request):
    return


def web_socket_transfer_data(request):
    uuid, direction = parse_request(request)
    log(uuid, f"Got web_socket_transfer_data {direction}")

    with stash.lock:
        value = stash.take(uuid)
        if value is None:
            queue = stash.get_queue()
            if direction == "read":
                has_reader = True
                writer_count = 0
            else:
                has_reader = False
                writer_count = 1
        else:
            queue, has_reader, writer_count = value
            if direction == "read":
                if has_reader:
                    raise ValueError("Tried to start multiple readers for the same queue")
            else:
                writer_count += 1

        stash.put(uuid, (queue, has_reader, writer_count))

    if direction == "read":
        run_read(request, uuid, queue)
    elif direction == "write":
        run_write(request, uuid, queue)

    log(uuid, f"transfer_data loop exited {direction}")
    close_channel(uuid, direction)


def web_socket_passive_closing_handshake(request):
    uuid, direction = parse_request(request)
    log(uuid, f"Got web_socket_passive_closing_handshake {direction}")

    if direction == "read":
        with stash.lock:
            data = stash.take(uuid)
            stash.put(uuid, data)
        if data is not None:
            queue = data[0]
            queue.put(("close", None))

    return request.ws_close_code, request.ws_close_reason


def parse_request(request):
    query = request.unparsed_uri.split('?')[1]
    GET = dict(urllib.parse.parse_qsl(query))
    uuid = GET["uuid"]
    direction = GET["direction"]
    return uuid, direction


def wait_for_close(request, uuid, queue):
    closed = False
    while not closed:
        try:
            line = request.ws_stream.receive_message()
            if line is None:
                break
            try:
                cmd, data = json.loads(line)
            except ValueError:
                cmd = None
            if cmd == "close":
                closed = True
                log(uuid, "Got client initiated close")
            else:
                logger.warning("Unexpected message on read socket  %s", line)
        except Exception:
            if not (request.server_terminated or request.client_terminated):
                log(uuid, "Got exception in wait_for_close\n %s" % (traceback.format_exc()))
            closed = True

    if not request.server_terminated:
        queue.put(("close", None))


def run_read(request, uuid, queue):
    close_thread = threading.Thread(target=wait_for_close, args=(request, uuid, queue), daemon=True)
    close_thread.start()

    while True:
        try:
            data = queue.get(True, 1)
        except Empty:
            if request.server_terminated or request.client_terminated:
                break
        else:
            cmd, body = data
            log(uuid, f"queue.get ({cmd}, {body})")
            if cmd == "close":
                break
            if cmd == "message":
                msgutil.send_message(request, json.dumps(body))
            else:
                logger.warning("Unknown queue command %s", cmd)


def run_write(request, uuid, queue):
    while True:
        line = request.ws_stream.receive_message()
        if line is None:
            break
        cmd, body = json.loads(line)
        if cmd == "pause":
            queue.put(("close", None))
        elif cmd == "message":
            log(uuid, f"queue.put ({cmd}, {body})")
            queue.put((cmd, body))
        elif cmd == "delete":
            close_channel(uuid, None)


def close_channel(uuid, direction):
    # Decrease the refcount of the queue
    # Direction of None indicates that we force delete the queue from the stash
    log(uuid, f"Got close_channel {direction}")
    with stash.lock:
        data = stash.take(uuid)
        if data is None:
            log(uuid, f"Message queue already deleted")
            return
        if direction is None:
            log(uuid, f"Force deleting message queue")
            return
        queue, has_reader, writer_count = data
        if direction == "read":
            has_reader = False
        else:
            writer_count -= 1

        if has_reader or writer_count > 0 or not queue.empty():
            log(uuid, f"Updating refcount {has_reader}, {writer_count}")
            stash.put(uuid, (queue, has_reader, writer_count))
        else:
            log(uuid, "Deleting message queue")
