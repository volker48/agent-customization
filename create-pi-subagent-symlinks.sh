#!/bin/bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
source_dir="${repo_dir}/pi-subagents/agents"
target_dir="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}/agents"
status=0

mkdir -p "${target_dir}"

for source in "${source_dir}"/*.md; do
	target="${target_dir}/$(basename "${source}")"

	if [[ -L "${target}" ]]; then
		if [[ $(readlink "${target}") == "${source}" ]]; then
			echo "Already linked: ${target}"
		else
			echo "Refusing to replace symlink: ${target}" >&2
			status=1
		fi
		continue
	fi

	if [[ -e "${target}" ]]; then
		echo "Refusing to replace file: ${target}" >&2
		status=1
		continue
	fi

	ln -s "${source}" "${target}"
	echo "Linked: ${target} -> ${source}"
done

exit "${status}"
