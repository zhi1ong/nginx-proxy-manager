import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import utils, { getPublicPorts } from "../lib/utils.js";

const renderTemplate = (template, data = {}, env = {}) => {
	const source = readFileSync(new URL(`../templates/${template}`, import.meta.url), "utf8");
	return utils.getRenderEngine(env).parseAndRender(source, data);
};

test("public ports use the official defaults", () => {
	assert.deepEqual(getPublicPorts({}), { http: 80, https: 443 });
	assert.deepEqual(getPublicPorts({ NPM_HTTP_PORT: "", NPM_HTTPS_PORT: "" }), { http: 80, https: 443 });
});

test("public ports accept custom values and normalize base 10", () => {
	assert.deepEqual(
		getPublicPorts({ NPM_HTTP_PORT: "08080", NPM_HTTPS_PORT: "08443", NPM_ADMIN_PORT: "081" }),
		{ http: 8080, https: 8443 },
	);
});

const invalidPorts = ["abc", " ", "-1", "+1", "1.5", "0x50", "0", "65536", "999999999999999999999", "80 "];
for (const value of invalidPorts) {
	test(`public ports reject ${JSON.stringify(value)}`, () => {
		assert.throws(() => getPublicPorts({ NPM_HTTP_PORT: value }), /NPM_HTTP_PORT/);
		assert.throws(() => getPublicPorts({ NPM_HTTPS_PORT: value }), /NPM_HTTPS_PORT/);
	});
}

test("public ports cannot conflict with each other or the admin listener", () => {
	assert.throws(
		() => getPublicPorts({ NPM_HTTP_PORT: "8080", NPM_HTTPS_PORT: "8080" }),
		/must be different/,
	);
	assert.throws(() => getPublicPorts({ NPM_HTTP_PORT: "81" }), /NPM_ADMIN_PORT/);
	assert.throws(() => getPublicPorts({ NPM_HTTP_PORT: "81", NPM_ADMIN_PORT: "invalid" }), /NPM_ADMIN_PORT/);
	assert.throws(
		() => getPublicPorts({ NPM_HTTPS_PORT: "09000", NPM_ADMIN_PORT: "9000" }),
		/NPM_ADMIN_PORT/,
	);
});

test("listener template retains default ports", async () => {
	const output = await renderTemplate("_listen.conf", {
		certificate: true,
		domain_names: ["example.com"],
		http2_support: false,
		ipv6: true,
	});

	assert.ok(output.includes("listen 80;"));
	assert.ok(output.includes("listen [::]:80;"));
	assert.ok(output.includes("listen 443 ssl;"));
	assert.ok(output.includes("listen [::]:443 ssl;"));
});

test("listener template uses custom ports and keeps disabled IPv6 SSL syntax", async () => {
	const env = { NPM_HTTP_PORT: "8080", NPM_HTTPS_PORT: "8443" };
	const output = await renderTemplate(
		"_listen.conf",
		{ certificate: true, domain_names: ["example.com"], http2_support: false, ipv6: false },
		env,
	);

	assert.ok(output.includes("listen 8080;"));
	assert.ok(output.includes("#listen [::]:8080;"));
	assert.ok(output.includes("listen 8443 ssl;"));
	assert.ok(output.includes("#listen [::]:8443 ssl;"));
	assert.ok(!output.includes("{{ npm_"));
});

test("default and certificate request templates use custom HTTP ports", async () => {
	const env = { NPM_HTTP_PORT: "8080", NPM_HTTPS_PORT: "8443" };
	const defaultOutput = await renderTemplate("default.conf", { ipv6: true, value: "404" }, env);
	const challengeOutput = await renderTemplate(
		"letsencrypt-request.conf",
		{ domain_names: ["example.com"], ipv6: true },
		env,
	);

	assert.ok(defaultOutput.includes("listen 8080 default;"));
	assert.ok(defaultOutput.includes("listen [::]:8080 default;"));
	assert.ok(challengeOutput.includes("listen 8080;"));
	assert.ok(challengeOutput.includes("listen [::]:8080;"));
});
