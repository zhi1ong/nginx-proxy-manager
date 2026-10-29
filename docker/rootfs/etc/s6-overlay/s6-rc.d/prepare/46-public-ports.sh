#!/command/with-contenv bash
# shellcheck shell=bash

# Configure public HTTP/HTTPS listeners and migrate existing NPM-managed
# configurations before nginx starts.

set -e

log_info 'Public HTTP/HTTPS Ports ...'

STATE_FILE=/data/nginx/.npm_public_ports
MANAGED_DIRS=(
	/data/nginx/default_host
	/data/nginx/proxy_host
	/data/nginx/redirection_host
	/data/nginx/dead_host
	/data/nginx/temp
)

# Print a normalized base-10 port, or return failure for invalid input.
canonical_port () {
	local value="$1"
	local normalized

	if ! [[ "$value" =~ ^[0-9]+$ ]]; then
		return 1
	fi

	# Strip leading zeroes first so arithmetic cannot interpret octal or overflow.
	local leading_zeroes="${value%%[!0]*}"
	normalized="${value#"$leading_zeroes"}"
	normalized="${normalized:-0}"

	if [ "${#normalized}" -gt 5 ] || (( 10#$normalized < 1 || 10#$normalized > 65535 )); then
		return 1
	fi

	printf '%s' "$normalized"
}

normalize_public_port () {
	local name="$1"
	local default_value="$2"
	local value="${!name:-$default_value}"
	local normalized

	if ! normalized="$(canonical_port "$value")"; then
		log_fatal "$name must be a whole number between 1 and 65535"
	fi
	printf -v "$name" '%s' "$normalized"
}

normalize_public_port NPM_HTTP_PORT 80
normalize_public_port NPM_HTTPS_PORT 443

if [ "$NPM_HTTP_PORT" = "$NPM_HTTPS_PORT" ]; then
	log_fatal 'NPM_HTTP_PORT and NPM_HTTPS_PORT must be different'
fi

# 45-admin-port.sh has already applied its numeric fallback. Repeat the
# non-numeric fallback here to keep this script consistent when tested alone.
ADMIN_VALUE="${NPM_ADMIN_PORT:-81}"
if ! [[ "$ADMIN_VALUE" =~ ^[0-9]+$ ]]; then
	ADMIN_VALUE=81
fi
ADMIN_PORT="$(canonical_port "$ADMIN_VALUE" || true)"
if [ "$NPM_HTTP_PORT" = "$ADMIN_PORT" ] || [ "$NPM_HTTPS_PORT" = "$ADMIN_PORT" ]; then
	log_fatal 'NPM_HTTP_PORT and NPM_HTTPS_PORT must differ from NPM_ADMIN_PORT'
fi

NPM_HTTPS_PORT_SUFFIX=''
if [ "$NPM_HTTPS_PORT" != '443' ]; then
	NPM_HTTPS_PORT_SUFFIX=":${NPM_HTTPS_PORT}"
fi

render_public_template () {
	local template="$1"
	local output="$2"
	local tmpfile="${output}.tmp"

	if is_mounted "$output"; then
		echo "WARNING: skipping ${output} — mounted file; update its public ports manually" >&2
		return 0
	fi
	if [ ! -f "$template" ]; then
		log_fatal "Missing public port template: ${template}"
	fi

	if sed -E \
		-e "s|\{\{NPM_HTTP_PORT\}\}|${NPM_HTTP_PORT}|g" \
		-e "s|\{\{NPM_HTTPS_PORT\}\}|${NPM_HTTPS_PORT}|g" \
		-e "s|\{\{NPM_HTTPS_PORT_SUFFIX\}\}|${NPM_HTTPS_PORT_SUFFIX}|g" \
		"$template" > "$tmpfile" && [ -s "$tmpfile" ]; then
		mv "$tmpfile" "$output"
		chown "$PUID:$PGID" "$output"
	else
		rm -f "$tmpfile"
		log_fatal "Failed to generate ${output} from template"
	fi
}

render_public_template /etc/nginx/conf.d/default.conf.template /etc/nginx/conf.d/default.conf
render_public_template /etc/nginx/conf.d/include/force-ssl.conf.template /etc/nginx/conf.d/include/force-ssl.conf

OLD_HTTP_PORT=80
OLD_HTTPS_PORT=443
if [ -f "$STATE_FILE" ]; then
	SAVED_HTTP="$(sed -n 's/^NPM_HTTP_PORT=\([0-9][0-9]*\)$/\1/p' "$STATE_FILE")"
	SAVED_HTTPS="$(sed -n 's/^NPM_HTTPS_PORT=\([0-9][0-9]*\)$/\1/p' "$STATE_FILE")"

	if VALID_HTTP="$(canonical_port "$SAVED_HTTP")" && \
		VALID_HTTPS="$(canonical_port "$SAVED_HTTPS")" && \
		[ "$VALID_HTTP" != "$VALID_HTTPS" ]; then
		OLD_HTTP_PORT="$VALID_HTTP"
		OLD_HTTPS_PORT="$VALID_HTTPS"
	else
		echo "WARNING: ignoring invalid public port state in ${STATE_FILE}" >&2
	fi
fi

migrate_managed_configs () {
	local directory file tmpfile

	if [ "$OLD_HTTP_PORT" = "$NPM_HTTP_PORT" ] && [ "$OLD_HTTPS_PORT" = "$NPM_HTTPS_PORT" ]; then
		return 0
	fi

	log_info "Migrating public listeners from ${OLD_HTTP_PORT}/${OLD_HTTPS_PORT} to ${NPM_HTTP_PORT}/${NPM_HTTPS_PORT} ..."
	for directory in "${MANAGED_DIRS[@]}"; do
		if [ ! -d "$directory" ]; then
			continue
		fi

		while IFS= read -r -d '' file; do
			if is_mounted "$file"; then
				echo "WARNING: skipping ${file} — mounted file" >&2
				continue
			fi
			if [ ! -s "$file" ]; then
				continue
			fi

			tmpfile="${file}.public-ports.tmp"
			if sed -E \
				-e "s/^([[:space:]]*#?listen[[:space:]]+(\[::\]:)?)${OLD_HTTP_PORT}([[:space:];])/\1__NPM_HTTP_PORT__\3/g" \
				-e "s/^([[:space:]]*#?listen[[:space:]]+(\[::\]:)?)${OLD_HTTPS_PORT}([[:space:];])/\1__NPM_HTTPS_PORT__\3/g" \
				-e "s/__NPM_HTTP_PORT__/${NPM_HTTP_PORT}/g" \
				-e "s/__NPM_HTTPS_PORT__/${NPM_HTTPS_PORT}/g" \
				"$file" > "$tmpfile" && [ -s "$tmpfile" ]; then
				mv "$tmpfile" "$file"
				chown "$PUID:$PGID" "$file"
			else
				rm -f "$tmpfile"
				log_fatal "Failed to migrate public listeners in ${file}"
			fi
		done < <(find "$directory" -type f -name '*.conf' -print0)
	done
}

migrate_managed_configs

if is_mounted "$STATE_FILE"; then
	echo "WARNING: skipping ${STATE_FILE} — mounted file" >&2
else
	STATE_TMP="${STATE_FILE}.tmp"
	if printf 'NPM_HTTP_PORT=%s\nNPM_HTTPS_PORT=%s\n' "$NPM_HTTP_PORT" "$NPM_HTTPS_PORT" > "$STATE_TMP"; then
		mv "$STATE_TMP" "$STATE_FILE"
		chown "$PUID:$PGID" "$STATE_FILE"
	else
		rm -f "$STATE_TMP"
		log_fatal "Failed to save public listener state in ${STATE_FILE}"
	fi
fi
