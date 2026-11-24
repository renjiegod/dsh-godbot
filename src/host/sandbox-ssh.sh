#!/bin/bash
set -eu
config=$1
host=$2
tty=$3
shift 3
case "$tty" in -T|-tt) ;; *) exit 2 ;; esac
ssh_args=(-F "$config" -o BatchMode=yes -o ForwardAgent=no -o ForwardX11=no
  -o ControlPath=none -o ExitOnForwardFailure=yes "$tty")
if [[ "${1:-}" == -R ]]; then
  ssh_args+=(-R "$2")
  shift 2
fi
[[ "${1:-}" == -- ]] || exit 2
shift
# OpenSSH sends one command string. Quote each argument for the guest shell.
command=''
for arg; do
  command+=" '"
  while [[ "$arg" == *"'"* ]]; do
    command+="${arg%%\'*}'\\''"
    arg=${arg#*\'}
  done
  command+="$arg'"
done
exec /usr/bin/ssh "${ssh_args[@]}" -- "$host" "$command"
