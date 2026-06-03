import { connect } from 'cloudflare:sockets';
import { toASCII } from 'punycode';

const HomePage = `
<!DOCTYPE html>
<html>

<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Whois | Created by aber</title>
</head>

<body>
    <form>
        <div>
            <input name="domain" type="search" />
            <button type="submit">→</button>
        </div>
    </form>
    <style>
        body {
            background-color: #fafafa;
        }

        form {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            margin-top: 100px;
        }

        div {
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: center;
            border: solid 1px #fafafa;
            box-shadow: 0 0 10px #eee;
        }

        input {
            width: calc(240px + 7vw);
            height: 40px;
            border-radius: 0px;
            border: none;
            outline: none;
            padding: 0 10px;
            flex: 1;
        }

        button {
            width: 50px;
            height: 40px;
            border-radius: 0px;
            border: none;
            background-color: #fff;
            color: #000;
            font-size: 16px;
            cursor: pointer;
        }
    </style>
</body>

</html>
`;

const ResultPage = `
<!DOCTYPE html>
<html>

<head>
    <meta charset="UTF-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Whois | Created by aber</title>
</head>

<body>
    <form>
        <div>
            <input name="domain" type="search" value="" />
            <button type="submit">→</button>
        </div>
    </form>
	<textarea></textarea>
    <style>
        body {
            background-color: #fafafa;
        }

        form {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            margin-top: 100px;
        }

        div {
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: center;
            border: solid 1px #fafafa;
            box-shadow: 0 0 10px #eee;
        }

        input {
            width: calc(240px + 7vw);
            height: 40px;
            border-radius: 0px;
            border: none;
            outline: none;
            padding: 0 10px;
            flex: 1;
        }

        button {
            width: 50px;
            height: 40px;
            border-radius: 0px;
            border: none;
            background-color: #fff;
            color: #000;
            font-size: 16px;
            cursor: pointer;
        }

		pre {
			width: 100%;
			margin: 2rem auto;
			max-width: 50rem;
			overflow-x: auto;
			white-space: break-spaces;
			background: #fff;
			padding: 1rem;
			box-sizing: border-box;
			box-shadow: inset 0 0 10px #eee;
		}
    </style>
</body>

</html>
`;

function parseHeader(
	mediaTypeRawLine: string,
): [string, Record<string, string>] {
	let parts = mediaTypeRawLine.split(';');
	let fullType = parts[0].trim();
	let options: Record<string, string> = {};

	for (let i = 1; i < parts.length; i++) {
		let optionParts = parts[i].split('=');
		if (optionParts.length === 2) {
			let key = optionParts[0].trim();
			let value = optionParts[1].trim();
			options[key] = value;
		}
	}

	return [fullType, options];
}

class MediaType {
	mainType: string;
	subType: string;
	options: Record<string, string>;

	constructor(mediaTypeRawLine: string) {
		let fullType, options;
		[fullType, options] = parseHeader(mediaTypeRawLine);
		[this.mainType, this.subType] = fullType.split('/');
		this.options = options;
	}

	get isAllTypes() {
		return this.mainType === '*' && this.subType === '*';
	}

	match(other: string) {
		if (this.isAllTypes) {
			return true;
		}
		let otherMediaType = new MediaType(other);
		return (
			this.mainType === otherMediaType.mainType &&
			(this.subType === '*' || this.subType === otherMediaType.subType)
		);
	}
}

function accepts(accept_line: string, expects: string[]): string | undefined {
	for (const media_type of accept_line
		.split(',')
		.filter((token) => token.trim())
		.map((token) => new MediaType(token))) {
		for (const expect_media_type of expects) {
			if (media_type.match(expect_media_type)) {
				return expect_media_type;
			}
		}
	}
}

// CORS: 前端(peer.as)在浏览器里直连本 worker 做 WHOIS 兜底, 需放开跨域。
const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, OPTIONS',
	'Access-Control-Allow-Headers': 'Accept',
};

export default {
	async fetch(request, env, ctx) {
		try {
			if (request.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: CORS });
			}
			const { host, pathname, searchParams } = new URL(request.url);
			if (pathname == '/' && !searchParams.get('domain')) {
				return new Response(HomePage, {
					headers: { 'content-type': 'text/html', ...CORS },
				});
			}
			let domain: string = decodeURI(pathname).slice(1);
			if (searchParams.get('domain')) {
				domain = searchParams.get('domain') as string;
			}
			const ascii_domain = domain.split('.').map(toASCII).join('.');
			const suffix =
				ascii_domain.split('.')[ascii_domain.split('.').length - 1];
			const resp = await fetch(
				`https://www.iana.org/domains/root/db/${toASCII(suffix)}.html`,
				{
					headers: {
						'User-Agent': request.headers.get('User-Agent') ?? 'http-whois',
					},
				},
			);
			switch (resp.status) {
				case 404:
					return new Response(`No such top-level domain '${suffix}'`, {
						status: 404,
						headers: CORS,
					});
				case 200:
					// 只抓主机名: IANA 页面该行形如 `<b>WHOIS Server:</b> whois.x.tld <br>`,
					// 原正则的 (.*) 会把尾部 ` <br>` 一并吞进去, 导致 connect 收到非法地址。
					const whois_server_re = /WHOIS Server:<\/b>\s*([^\s<]+)/;
					let whois_servers = whois_server_re.exec(await resp.text());
					if (!whois_servers || !whois_servers[1]) {
						return new Response(`No WHOIS server found for '${suffix}'`, {
							status: 404,
							headers: CORS,
						});
					}
					const whois_server = whois_servers[1];
					let socket = connect({ hostname: whois_server, port: 43 });
					const writer = socket.writable.getWriter();
					const encoder = new TextEncoder();
					const encoded = encoder.encode(domain + '\r\n');
					await writer.write(encoded);
					// 读到 EOF: WHOIS 响应常跨多个 TCP 段, 单次 read 会截断/读空。
					let reader = socket.readable.getReader();
					const decoder = new TextDecoder();
					let whois = '';
					while (true) {
						const { value, done } = await reader.read();
						if (value) whois += decoder.decode(value, { stream: true });
						if (done) break;
					}
					whois += decoder.decode();

					const content_type = accepts(
						request.headers.get('Accept') || '*/*',
						['text/plain', 'application/json', 'text/html'],
					);
					switch (content_type) {
						case 'text/plain':
							return new Response(whois, {
								headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS },
							});
						case 'application/json':
							return new Response(
								JSON.stringify({
									server: whois_server,
									domain: ascii_domain,
									whois: whois,
								}),
								{
									headers: {
										'content-type': 'application/json',
										...CORS,
									},
								},
							);
						case 'text/html':
							return new Response(
								ResultPage.replace('value=""', `value="${domain}"`).replace(
									'<textarea></textarea>',
									`<pre>${whois}</pre>`,
								),
								{ headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } },
							);
					}
				default:
					return resp as unknown as Response;
			}
		} catch (err: any) {
			return new Response(err.stack, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
