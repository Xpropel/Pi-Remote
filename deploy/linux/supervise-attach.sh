#!/bin/sh
# Supervisor loop for the pi-remote attach window (Linux, run by device.sh up
# inside the pi-remote-attach tmux session).
#
# Runs the given command (node deploy/attach.cjs ...) and relaunches it only
# when attach asks for a self-restart by exiting with code 75 (system
# operations: restart_host / update_components). PI_REMOTE_SUPERVISED=1 is
# exported by the launcher (device.sh up) so attach knows this loop exists.
# Any other exit code ends the loop and becomes this script's exit code, so
# ordinary failures keep their usual pane-dead diagnostics.
while true; do
  "$@"
  exit_code=$?
  if [ "$exit_code" -ne 75 ]; then
    exit "$exit_code"
  fi
  sleep 1
done
