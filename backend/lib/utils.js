import { exec as nodeExec, execFile as nodeExecFile } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Liquid } from "liquidjs";
import _ from "lodash";
import errs from "./error.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const parsePublicPort = (name, value, defaultValue) => {
	if (typeof value === "undefined" || value === "") {
		return defaultValue;
	}

	if (!/^[0-9]+$/.test(value)) {
		throw new errs.ConfigurationError(`${name} must be a whole number between 1 and 65535`);
	}

	const port = Number(value);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new errs.ConfigurationError(`${name} must be a whole number between 1 and 65535`);
	}

	return port;
};

/**
 * Returns validated public listener ports and protects the admin listener from conflicts.
 *
 * @param   {Object} env
 * @returns {Object}
 */
const getPublicPorts = (env = process.env) => {
	const http = parsePublicPort("NPM_HTTP_PORT", env.NPM_HTTP_PORT, 80);
	const https = parsePublicPort("NPM_HTTPS_PORT", env.NPM_HTTPS_PORT, 443);
	const adminValue = env.NPM_ADMIN_PORT;
	let admin = 81;

	// Match 45-admin-port.sh: an invalid non-numeric admin port falls back to 81.
	if (typeof adminValue !== "undefined" && adminValue !== "" && /^[0-9]+$/.test(adminValue)) {
		admin = Number(adminValue);
	}

	if (http === https) {
		throw new errs.ConfigurationError("NPM_HTTP_PORT and NPM_HTTPS_PORT must be different");
	}
	if (http === admin || https === admin) {
		throw new errs.ConfigurationError("NPM_HTTP_PORT and NPM_HTTPS_PORT must differ from NPM_ADMIN_PORT");
	}

	return { http, https };
};

const exec = async (cmd, options = {}) => {
	const { stdout, stderr } = await new Promise((resolve, reject) => {
		const child = nodeExec(cmd, options, (isError, stdout, stderr) => {
			if (isError) {
				reject(new errs.CommandError(stderr, isError));
			} else {
				resolve({ stdout, stderr });
			}
		});

		child.on("error", (e) => {
			reject(new errs.CommandError(stderr, 1, e));
		});
	});
	return stdout;
};

/**
 * @param   {String} cmd
 * @param   {Array}  args
 * @param   {Object|undefined}  options
 * @returns {Promise}
 */
const execFile = (cmd, args, options) => {
	const opts = options || {};

	return new Promise((resolve, reject) => {
		nodeExecFile(cmd, args, opts, (err, stdout, stderr) => {
			if (err && typeof err === "object") {
				reject(new errs.CommandError(stderr, 1, err));
			} else {
				resolve(stdout.trim());
			}
		});
	});
};

/**
 * Used in objection query builder
 *
 * @param   {Array}  omissions
 * @returns {Function}
 */
const omitRow = (omissions) => {
	/**
	 * @param   {Object} row
	 * @returns {Object}
	 */
	return (row) => {
		return _.omit(row, omissions);
	};
};

/**
 * Used in objection query builder
 *
 * @param   {Array}  omissions
 * @returns {Function}
 */
const omitRows = (omissions) => {
	/**
	 * @param   {Array} rows
	 * @returns {Object}
	 */
	return (rows) => {
		rows.forEach((row, idx) => {
			rows[idx] = _.omit(row, omissions);
		});
		return rows;
	};
};

/**
 * @param   {Object} env
 * @returns {Object} Liquid render engine
 */
const getRenderEngine = (env = process.env) => {
	const publicPorts = getPublicPorts(env);
	const renderEngine = new Liquid({
		root: `${__dirname}/../templates/`,
		globals: {
			npm_http_port: publicPorts.http,
			npm_https_port: publicPorts.https,
		},
	});

	/**
	 * nginxAccessRule expects the object given to have 2 properties:
	 *
	 * directive  string
	 * address    string
	 */
	renderEngine.registerFilter("nginxAccessRule", (v) => {
		if (typeof v.directive !== "undefined" && typeof v.address !== "undefined" && v.directive && v.address) {
			return `${v.directive} ${v.address};`;
		}
		return "";
	});

	return renderEngine;
};

export { getPublicPorts };
export default { exec, execFile, omitRow, omitRows, getPublicPorts, getRenderEngine };
