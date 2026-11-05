const $ = selector => document.querySelector(selector);

const state = {
    current: null,
    previous: null,
    report: null,
    configText: ""
};

const BUILTIN_CLASSES = new Set([
    "Map", "Set", "WeakMap", "WeakSet", "Array", "Object", "Date",
    "RegExp", "Promise", "Error", "Function", "String", "Number",
    "Boolean", "JSON", "Math"
]);

const PROTO_ASSIGN = /([A-Za-z_$][\w$]*)\s*\[\s*['"]prototype['"]\s*\]\s*\[\s*['"]([A-Za-z_$][\w$]*)['"]\s*\]\s*=\s*function\s*\([^)]*\)\s*\{/g;

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineOf(text, index) {
    return text.slice(0, index).split("\n").length;
}

function braceEnd(text, startIndex) {
    let depth = 1;
    let i = startIndex;
    let inString = null;

    while (i < text.length && depth > 0) {
        const c = text[i];

        if (inString) {
            if (c === "\\") {
                i += 2;
                continue;
            }

            if (c === inString) {
                inString = null;
            }
        } else if (c === '"' || c === "'" || c === "`") {
            inString = c;
        } else if (c === "{") {
            depth++;
        } else if (c === "}") {
            depth--;
        }

        i++;
    }

    return i;
}

function constructorBody(text, className) {
    const re = new RegExp(
        "const\\s+" + escapeRegExp(className) +
        "\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{"
    );

    const match = re.exec(text);

    if (!match) {
        return "";
    }

    const start = match.index + match[0].length;
    return text.slice(start, braceEnd(text, start) - 1);
}

function findFile(sources, ...suffixes) {
    for (const [name, text] of Object.entries(sources)) {
        if (suffixes.some(suffix => name.endsWith(suffix))) {
            return [name, text];
        }
    }

    return ["", ""];
}

async function readZipSources(file) {
    if (typeof JSZip === "undefined") {
        throw new Error("JSZip could not be loaded. Check your internet connection.");
    }

    const zip = await JSZip.loadAsync(file);
    const sources = {};

    const entries = Object.values(zip.files).filter(entry =>
        !entry.dir && /\.(js|mjs)$/i.test(entry.name)
    );

    if (!entries.length) {
        throw new Error("No JavaScript files (.js or .mjs) were found in this ZIP.");
    }

    for (const entry of entries) {
        try {
            sources[entry.name] = await entry.async("string");
        } catch (_) {
        }
    }

    return sources;
}

function extractClientGlobal(sources) {
    for (const [name, text] of Object.entries(sources)) {
        const index = text.indexOf("gameclient-ctor");

        if (index >= 0) {
            const after = text.slice(index, index + 2000);
            const match = /([A-Za-z_$][\w$]*)\s*=\s*new\s+[A-Za-z_$][\w$]*\s*\(/.exec(after);

            if (match) {
                return {
                    value: match[1],
                    file: name,
                    line: lineOf(text, index + match.index),
                    evidence: "Marker 'gameclient-ctor'."
                };
            }
        }
    }

    const fileRefs = new Map();

    for (const text of Object.values(sources)) {
        const seen = new Set();
        const re = /\b([A-Za-z_$][\w$]{4,})\s*\[\s*['"][A-Za-z_$]/g;

        let match;

        while ((match = re.exec(text))) {
            seen.add(match[1]);
        }

        for (const value of seen) {
            fileRefs.set(value, (fileRefs.get(value) || 0) + 1);
        }
    }

    if (fileRefs.size) {
        const [value, count] = [...fileRefs.entries()]
            .sort((a, b) => b[1] - a[1])[0];

        return {
            value,
            file: null,
            line: null,
            evidence: `Referenced in ${count} files.`
        };
    }

    return {
        value: null,
        file: null,
        line: null,
        evidence: "Not found."
    };
}

function extractChannel(sources) {
    const [name, text] = findFile(sources, "/src/utils/channel.js");

    if (!text) {
        return {
            class: null,
            contents_prop: "__contents",
            add_method: null,
            name_prop: "name",
            evidence: "channel.js not found."
        };
    }

    let contentsProp = "__contents";

    let match = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*new\s+Array/.exec(text);

    if (match) {
        contentsProp = match[1];
    }

    let nameProp = "name";

    match = /function\s*\(\s*(\w+)\s*,\s*(\w+)\s*\)\s*\{\s*this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*\1/.exec(text);

    if (match) {
        nameProp = match[3];
    }

    const matches = [...text.matchAll(PROTO_ASSIGN)];
    const candidates = [];

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];

        const cls = m[1];
        const method = m[2];

        const bodyStart = m.index + m[0].length;
        const bodyEnd = i + 1 < matches.length
            ? matches[i + 1].index
            : Math.min(text.length, bodyStart + 4000);

        const body = text.slice(bodyStart, bodyEnd);
        const prop = escapeRegExp(contentsProp);

        const hasPush = new RegExp(
            "this\\s*\\[\\s*['\"]" + prop +
            "['\"]\\s*\\]\\s*\\[\\s*['\"]push['\"]\\s*\\]"
        ).test(body);

        const hasSlice = new RegExp(
            "this\\s*\\[\\s*['\"]" + prop +
            "['\"]\\s*\\]\\s*=\\s*this\\s*\\[\\s*['\"]" +
            prop + "['\"]\\s*\\]\\s*\\[\\s*['\"](?:slice|length)['\"]"
        ).test(body);

        if (hasPush && hasSlice) {
            const addMatch = /\[['"]addMessage['"]\]\s*=\s*function\s*\([^)]*\)\s*\{([^}]{0,400})\}/.exec(text);

            const delegated = Boolean(
                addMatch && addMatch[1].includes(`['${method}']`)
            );

            candidates.push({
                cls,
                method,
                delegated
            });
        }
    }

    if (!candidates.length) {
        return {
            class: null,
            contents_prop: contentsProp,
            add_method: null,
            name_prop: nameProp,
            evidence: `No method with push+slice found in '${contentsProp}'.`
        };
    }

    candidates.sort((a, b) =>
        Number(b.delegated) - Number(a.delegated)
    );

    const chosen = candidates[0];

    return {
        class: chosen.cls,
        contents_prop: contentsProp,
        add_method: chosen.method,
        name_prop: nameProp,
        evidence:
            `'${chosen.method}' uses push+slice in '${contentsProp}'` +
            (chosen.delegated ? " (called by addMessage)." : ".")
    };
}

function extractManager(sources, clientGlobal) {
    const [name, text] = findFile(
        sources,
        "/src/utils/channel-manager.js"
    );

    if (!text) {
        return {
            class: null,
            path: null,
            channels_prop: "channels",
            evidence: "channel-manager.js not found."
        };
    }

    let cls = null;
    let channelsProp = "channels";

    const match = /const\s+(\w+)\s*=\s*function\s*\([^)]*\)\s*\{\s*this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*new\s+Array/.exec(text);

    if (match) {
        cls = match[1];
        channelsProp = match[2];
    }

    let path = null;

    if (cls && clientGlobal) {
        let managerProp = null;

        for (const source of Object.values(sources)) {
            const re = new RegExp(
                "this\\s*\\[\\s*['\"](\\w+)['\"]\\s*\\]\\s*=\\s*new\\s+" +
                escapeRegExp(cls) + "\\s*\\("
            );

            const found = re.exec(source);

            if (found) {
                managerProp = found[1];
                break;
            }
        }

        if (managerProp) {
            const re = new RegExp(
                "\\b" + escapeRegExp(clientGlobal) +
                "\\s*\\[\\s*['\"](\\w+)['\"]\\s*\\]\\s*\\[\\s*['\"]" +
                escapeRegExp(managerProp) + "['\"]\\s*\\]"
            );

            for (const source of Object.values(sources)) {
                const found = re.exec(source);

                if (found) {
                    path = [found[1], managerProp];
                    break;
                }
            }
        }
    }

    return {
        class: cls,
        path,
        channels_prop: channelsProp,
        evidence: `path=${JSON.stringify(path)}, channels='${channelsProp}'.`
    };
}

function extractMobile(sources) {
    const [name, text] = findFile(
        sources,
        "/src/ui/mobile-chat.js"
    );

    if (!text) {
        return {
            class: null,
            touch_class: null,
            path: null,
            tabs_prop: "__tabEls",
            keyboard_prop: "__keyboard",
            input_prop: "__input",
            evidence: "mobile-chat.js not found."
        };
    }

    let cls = null;

    const constructors = [
        ...text.matchAll(
            /const\s+(\w+)\s*=\s*function\s*\([^)]*\)\s*\{/g
        )
    ];

    for (const m of constructors) {
        const body = constructorBody(text, m[1]);

        if (
            (body.includes("['__tabEls']") || body.includes('["__tabEls"]')) &&
            (body.includes("['__keyboard']") || body.includes('["__keyboard"]'))
        ) {
            cls = m[1];
            break;
        }
    }

    if (!cls && constructors.length) {
        cls = constructors[0][1];
    }

    let tabsProp = "__tabEls";
    let keyboardProp = "__keyboard";
    let inputProp = "__input";

    if (cls) {
        const body = constructorBody(text, cls);

        const maps = [
            ...body.matchAll(
                /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*new\s+Map/g
            )
        ].map(m => m[1]);

        for (const candidate of maps) {
            const setPat = new RegExp(
                "this\\s*\\[\\s*['\"]" +
                escapeRegExp(candidate) +
                "['\"]\\s*\\]\\s*(?:\\.\\s*set|\\[\\s*['\"]set['\"]\\s*\\])\\s*\\([^)]*,\\s*\\{",
                "s"
            );

            if (setPat.test(text)) {
                tabsProp = candidate;
                break;
            }
        }

        const custom = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*new\s+([A-Za-z_$]\w*)\s*\(/g;

        let match;

        while ((match = custom.exec(body))) {
            if (!BUILTIN_CLASSES.has(match[2])) {
                keyboardProp = match[1];
                break;
            }
        }

        const inputMatch = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*document\s*(?:\.\s*querySelector|\[\s*['"]querySelector['"]\s*\])\s*\(\s*['"]\.mobile-chat-msg['"]/.exec(body);

        if (inputMatch) {
            inputProp = inputMatch[1];
        }
    }

    let mobileProp = null;
    let touchClass = null;

    if (cls) {
        for (const source of Object.values(sources)) {
            const re = new RegExp(
                "this\\s*\\[\\s*['\"](\\w+)['\"]\\s*\\]\\s*=\\s*new\\s+" +
                escapeRegExp(cls) +
                "\\s*\\(\\s*this\\s*\\)"
            );

            const found = re.exec(source);

            if (found) {
                mobileProp = found[1];

                const prefix = source.slice(0, found.index);

                const tm = [
                    ...prefix.matchAll(
                        /const\s+(\w+)\s*=\s*function\s*\([^)]*\)\s*\{/g
                    )
                ];

                if (tm.length) {
                    touchClass = tm[tm.length - 1][1];
                }

                break;
            }
        }
    }

    let touchProp = "touch";

    if (touchClass) {
        for (const source of Object.values(sources)) {
            const re = new RegExp(
                "this\\s*\\[\\s*['\"](\\w+)['\"]\\s*\\]\\s*=\\s*new\\s+" +
                escapeRegExp(touchClass) + "\\s*\\("
            );

            const found = re.exec(source);

            if (found) {
                touchProp = found[1];
                break;
            }
        }
    }

    const path = touchProp && mobileProp
        ? [touchProp, mobileProp]
        : null;

    return {
        class: cls,
        touch_class: touchClass,
        path,
        tabs_prop: tabsProp,
        keyboard_prop: keyboardProp,
        input_prop: inputProp,
        evidence: `tabs='${tabsProp}', keyboard='${keyboardProp}', input='${inputProp}'.`
    };
}

function extractVk(sources) {
    const [name, text] = findFile(
        sources,
        "/src/ui/virtual-keyboard.js"
    );

    const defaults = {
        class: null,
        render_methods: [],
        set_methods: [],
        buffer_prop: "__buffer",
        cursor_prop: "__cursorPos",
        input_display_prop: "__inputDisplay",
        visible_prop: "__visible",
        sel_anchor_prop: "__selAnchor"
    };

    if (!text) {
        return {
            ...defaults,
            evidence: "virtual-keyboard.js not found."
        };
    }

    const clsMatch = /const\s+(\w+)\s*=\s*function\s*\([^)]*\)\s*\{/.exec(text);
    const cls = clsMatch ? clsMatch[1] : null;

    let bufferProp = "__buffer";
    let cursorProp = "__cursorPos";
    let inputDisplayProp = "__inputDisplay";
    let visibleProp = "__visible";
    let selAnchorProp = "__selAnchor";

    if (cls) {
        const ctorBody = constructorBody(text, cls);

        let m = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*''/.exec(ctorBody);

        if (m) bufferProp = m[1];

        m = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*0x0\b/.exec(ctorBody);

        if (m) cursorProp = m[1];

        m = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*null/.exec(ctorBody);

        if (m) selAnchorProp = m[1];

        m = /this\s*\[\s*['"](\w+)['"]\s*\]\s*=\s*!\[\]/.exec(ctorBody);

        if (m) visibleProp = m[1];

        m = new RegExp(
            "const\\s+" + escapeRegExp(cls) +
            "\\s*=\\s*function\\s*\\(\\s*(\\w+)\\s*,\\s*(\\w+)\\s*\\)\\s*\\{" +
            "\\s*this\\s*\\[\\s*['\"](\\w+)['\"]\\s*\\]\\s*=\\s*\\1"
        ).exec(text);

        if (m) {
            inputDisplayProp = m[3];
        }
    }

    const renderMethods = [];
    const setMethods = [];

    const renderRe = new RegExp(
        "this\\s*\\[\\s*['\"]" +
        escapeRegExp(inputDisplayProp) +
        "['\"]\\s*\\]\\s*\\[\\s*['\"]textContent['\"]\\s*\\]\\s*="
    );

    const setRe = new RegExp(
        "this\\s*\\[\\s*['\"]" +
        escapeRegExp(bufferProp) +
        "['\"]\\s*\\]\\s*=\\s*_?\\w+\\s*\\|\\|" +
        ".{0,300}" +
        "this\\s*\\[\\s*['\"]" +
        escapeRegExp(cursorProp) +
        "['\"]\\s*\\]\\s*=\\s*this\\s*\\[\\s*['\"]" +
        escapeRegExp(bufferProp) +
        "['\"]\\s*\\]\\s*\\[\\s*['\"]length['\"]",
        "s"
    );

    const methods = [...text.matchAll(PROTO_ASSIGN)];

    for (let i = 0; i < methods.length; i++) {
        const m = methods[i];

        const method = m[2];
        const bodyStart = m.index + m[0].length;

        const bodyEnd = i + 1 < methods.length
            ? methods[i + 1].index
            : Math.min(text.length, bodyStart + 5000);

        const body = text.slice(bodyStart, bodyEnd);

        const hasBuffer =
            body.includes(`this['${bufferProp}']`) ||
            body.includes(`this["${bufferProp}"]`);

        const hasCursor =
            body.includes(`this['${cursorProp}']`) ||
            body.includes(`this["${cursorProp}"]`);

        if (renderRe.test(body) && hasBuffer && hasCursor) {
            renderMethods.push(method);
        }

        if (setRe.test(body)) {
            setMethods.push(method);
        }
    }

    return {
        class: cls,
        render_methods: renderMethods,
        set_methods: setMethods,
        buffer_prop: bufferProp,
        cursor_prop: cursorProp,
        input_display_prop: inputDisplayProp,
        visible_prop: visibleProp,
        sel_anchor_prop: selAnchorProp,
        evidence:
            `render=${JSON.stringify(renderMethods)}, ` +
            `set=${JSON.stringify(setMethods)}, ` +
            `buffer='${bufferProp}', cursor='${cursorProp}'.`
    };
}

function extractPlayer(sources, clientGlobal) {
    if (!clientGlobal) {
        return {
            path: ["player"],
            name_prop: "name",
            evidence: "No client global."
        };
    }

    const propCounts = new Map();
    const methodCounts = new Map();

    const re = new RegExp(
        "\\b" + escapeRegExp(clientGlobal) +
        "\\s*\\[\\s*['\"]player['\"]\\s*\\]\\s*" +
        "\\[\\s*['\"](\\w+)['\"]\\s*\\](\\()?",
        "g"
    );

    for (const text of Object.values(sources)) {
        let match;

        while ((match = re.exec(text))) {
            const map = match[2] === "("
                ? methodCounts
                : propCounts;

            map.set(
                match[1],
                (map.get(match[1]) || 0) + 1
            );
        }

        re.lastIndex = 0;
    }

    for (const preferred of [
        "name",
        "charName",
        "playerName",
        "displayName"
    ]) {
        if (propCounts.has(preferred)) {
            return {
                path: ["player"],
                name_prop: preferred,
                evidence:
                    `'${clientGlobal}['player']['${preferred}']' ` +
                    `(non-method, ${propCounts.get(preferred)}x).`
            };
        }
    }

    if (propCounts.size) {
        const [prop, count] = [...propCounts.entries()]
            .sort((a, b) => b[1] - a[1])[0];

        return {
            path: ["player"],
            name_prop: prop,
            evidence: `Fallback: '${prop}' (${count}x).`
        };
    }

    return {
        path: ["player"],
        name_prop: "name",
        evidence: "Not found; using default."
    };
}

function extractMessage(sources, clientGlobal) {
    let textProps = ["message"];
    let senderProps = ["name"];

    const [name, text] = findFile(
        sources,
        "/src/utils/channel.js"
    );

    if (!text) {
        return {
            text_props: textProps,
            sender_props: senderProps,
            evidence: "channel.js not found."
        };
    }

    let match = /__contents['"]\s*\]\s*\[\s*['"]last['"]\s*\]\s*\(\s*\)\s*\[\s*['"](\w+)['"]\s*\]/.exec(text);

    if (match) {
        textProps = [match[1]];
    }

    if (clientGlobal) {
        const re = new RegExp(
            "\\b" + escapeRegExp(clientGlobal) +
            "\\s*\\[\\s*['\"]player['\"]\\s*\\]\\s*" +
            "\\[\\s*['\"]name['\"]\\s*\\]\\s*===\\s*\\w+\\s*" +
            "\\[\\s*['\"](\\w+)['\"]\\s*\\]"
        );

        match = re.exec(text);

        if (match) {
            senderProps = [match[1]];
        }
    }

    return {
        text_props: textProps,
        sender_props: senderProps,
        evidence:
            `text=${JSON.stringify(textProps)}, ` +
            `sender=${JSON.stringify(senderProps)}.`
    };
}

async function analyze(file) {
    const sources = await readZipSources(file);

    const client = extractClientGlobal(sources);
    const channel = extractChannel(sources);
    const manager = extractManager(sources, client.value);
    const mobile = extractMobile(sources);
    const vk = extractVk(sources);
    const player = extractPlayer(sources, client.value);
    const message = extractMessage(sources, client.value);

    const config = {
        clientGlobalNames: client.value ? [client.value] : [],
        clientManagerPaths: manager.path ? [manager.path] : [],
        channelAddMethodNames: channel.add_method ? [channel.add_method] : [],
        mobileChatPath: mobile.path || [],
        virtualKeyboardRenderMethodNames: vk.render_methods,
        virtualKeyboardSetTextMethodNames: vk.set_methods,
        channelsProperty: manager.channels_prop,
        channelContentsProperty: channel.contents_prop,
        virtualKeyboardBufferProperty: vk.buffer_prop,
        virtualKeyboardCursorProperty: vk.cursor_prop,
        virtualKeyboardInputDisplayProperty: vk.input_display_prop,
        playerPath: player.path,
        playerNameProperty: player.name_prop,
        messageTextProperties: message.text_props,
        messageSenderProperties: message.sender_props,
        channelNameProperty: channel.name_prop,
        mobileTabsProperty: mobile.tabs_prop,
        mobileKeyboardProperty: mobile.keyboard_prop,
        mobileInputProperty: mobile.input_prop,
        virtualKeyboardVisibleProperty: vk.visible_prop,
        virtualKeyboardSelectionAnchorProperty: vk.sel_anchor_prop
    };

    const critical = [
        ["clientGlobalNames", config.clientGlobalNames],
        ["clientManagerPaths", config.clientManagerPaths],
        ["channelAddMethodNames", config.channelAddMethodNames],
        ["mobileChatPath", config.mobileChatPath],
        ["virtualKeyboardRenderMethodNames", config.virtualKeyboardRenderMethodNames],
        ["virtualKeyboardSetTextMethodNames", config.virtualKeyboardSetTextMethodNames]
    ];

    const errors = critical
        .filter(([, value]) => !value.length)
        .map(([key]) => key);

    return {
        zip: file.name,
        client_global: client,
        channel,
        manager,
        mobile,
        vk,
        player,
        message,
        suggested_userscript_config: config,
        errors
    };
}

function flatten(data, prefix = "") {
    const values = {};

    if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [key, value] of Object.entries(data)) {
            if (
                ["zip", "file", "path_files", "evidence", "line"].includes(key)
            ) {
                continue;
            }

            Object.assign(
                values,
                flatten(value, prefix ? `${prefix}.${key}` : key)
            );
        }
    } else if (Array.isArray(data)) {
        values[prefix] = JSON.stringify(data);
    } else {
        values[prefix] = data;
    }

    return values;
}

function stringifyValue(value) {
    if (value === undefined) {
        return "undefined";
    }

    return JSON.stringify(value);
}

function renderDetail(title, object, keys) {
    const rows = keys.map(key => `
        <div class="detail-row">
            <span>${escapeHTML(key)}</span>
            <span>${escapeHTML(stringifyValue(object[key]))}</span>
        </div>
    `).join("");

    return `
        <article class="detail-card">
            <h3>${escapeHTML(title)}</h3>
            ${rows}
        </article>
    `;
}

function renderReport(report, previous) {
    const config = report.suggested_userscript_config;

    $("#results").classList.remove("hidden");

    $("#resultBadge").textContent = report.errors.length
        ? `${report.errors.length} CRITICAL FIELD(S) MISSING`
        : "ANALYSIS COMPLETE";

    $("#summary").innerHTML = [
        ["Client global", report.client_global.value || "Not found"],
        ["Channel class", report.channel.class || "Not found"],
        ["Mobile chat", report.mobile.class || "Not found"],
        ["VK class", report.vk.class || "Not found"]
    ].map(([label, value]) => `
        <div class="metric">
            <span>${escapeHTML(label)}</span>
            <strong>${escapeHTML(value)}</strong>
        </div>
    `).join("");

    const errors = $("#errors");

    if (report.errors.length) {
        errors.classList.remove("hidden");

        errors.innerHTML = `
            <strong>Critical fields missing</strong>
            <ul>
                ${report.errors.map(error =>
                    `<li>${escapeHTML(error)}</li>`
                ).join("")}
            </ul>
        `;
    } else {
        errors.classList.add("hidden");
        errors.innerHTML = "";
    }

    $("#details").innerHTML = [
        renderDetail("Client global", report.client_global, [
            "value", "file", "line", "evidence"
        ]),
        renderDetail("Channel", report.channel, [
            "class", "contents_prop", "add_method", "name_prop", "evidence"
        ]),
        renderDetail("Manager", report.manager, [
            "class", "path", "channels_prop", "evidence"
        ]),
        renderDetail("Mobile chat", report.mobile, [
            "class", "touch_class", "path", "tabs_prop",
            "keyboard_prop", "input_prop", "evidence"
        ]),
        renderDetail("Virtual keyboard", report.vk, [
            "class", "render_methods", "set_methods",
            "buffer_prop", "cursor_prop", "input_display_prop",
            "visible_prop", "sel_anchor_prop", "evidence"
        ]),
        renderDetail("Player", report.player, [
            "path", "name_prop", "evidence"
        ]),
        renderDetail("Message", report.message, [
            "text_props", "sender_props", "evidence"
        ])
    ].join("");

    if (previous) {
        $("#diffSection").classList.remove("hidden");

        const oldValues = flatten(
            previous.suggested_userscript_config
        );

        const newValues = flatten(config);

        const keys = [
            ...new Set([
                ...Object.keys(oldValues),
                ...Object.keys(newValues)
            ])
        ].sort();

        const changes = keys.filter(
            key => oldValues[key] !== newValues[key]
        );

        $("#diffCount").textContent = `${changes.length} change(s)`;

        $("#diffs").innerHTML = changes.length
            ? changes.map(key => `
                <div class="diff-item">
                    <span>${escapeHTML(key)}</span>
                    <code>${escapeHTML(stringifyValue(oldValues[key]))}</code>
                    <code>${escapeHTML(stringifyValue(newValues[key]))}</code>
                </div>
            `).join("")
            : `<p class="no-diff">No differences found.</p>`;
    } else {
        $("#diffSection").classList.add("hidden");
    }

    state.configText =
        "const CLIENT_CONFIG = " +
        JSON.stringify(config, null, 4) +
        ";\n";

    $("#configOutput").textContent = state.configText;

    updateExportButtons();
}

function updateExportButtons() {
    const blocked = Boolean(
        state.report &&
        $("#strictMode").checked &&
        state.report.current.errors.length
    );

    $("#downloadJs").disabled = blocked;
    $("#downloadJson").disabled = blocked;
}

function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = name;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("#currentZip").addEventListener("change", event => {
    const file = event.target.files[0] || null;

    state.current = file;
    state.report = null;
    state.configText = "";

    $("#currentName").textContent = file
        ? file.name
        : "Choose a .zip file";

    $("#analyzeButton").disabled = !file;
    $("#results").classList.add("hidden");
    $("#status").textContent = "";
});

$("#previousZip").addEventListener("change", event => {
    const file = event.target.files[0] || null;

    state.previous = file;

    $("#previousName").textContent = file
        ? file.name
        : "Optional — compare versions";
});

$("#strictMode").addEventListener("change", () => {
    updateExportButtons();
});

$("#analyzeButton").addEventListener("click", async () => {
    if (!state.current) {
        return;
    }

    const button = $("#analyzeButton");
    const status = $("#status");

    button.disabled = true;
    button.textContent = "Analyzing...";

    status.className = "status";
    status.textContent =
        "Reading ZIP files and analyzing JavaScript sources...";

    try {
        const currentReport = await analyze(state.current);

        const previousReport = state.previous
            ? await analyze(state.previous)
            : null;

        state.report = {
            current: currentReport,
            previous: previousReport
        };

        renderReport(currentReport, previousReport);

        if (
            $("#strictMode").checked &&
            currentReport.errors.length
        ) {
            status.className = "status error";
            status.textContent =
                "Strict mode: critical fields are missing. Review the results.";
        } else {
            status.className = "status success";
            status.textContent = "Analysis completed successfully.";
        }

        $("#results").scrollIntoView({
            behavior: "smooth",
            block: "start"
        });

    } catch (error) {
        console.error(error);

        status.className = "status error";
        status.textContent =
            error.message || "Could not analyze this ZIP file.";

        $("#results").classList.add("hidden");

    } finally {
        button.disabled = !state.current;
        button.innerHTML = 'Analyze client <span>→</span>';
    }
});

$("#copyButton").addEventListener("click", async () => {
    if (!state.configText) {
        return;
    }

    try {
        await navigator.clipboard.writeText(state.configText);
    } catch (_) {
        const area = document.createElement("textarea");

        area.value = state.configText;
        document.body.appendChild(area);

        area.select();
        document.execCommand("copy");

        area.remove();
    }

    const button = $("#copyButton");

    button.textContent = "Copied!";

    setTimeout(() => {
        button.textContent = "Copy config";
    }, 1600);
});

$("#downloadJs").addEventListener("click", () => {
    if (!state.configText || $("#downloadJs").disabled) {
        return;
    }

    downloadFile(
        "config_client.js",
        state.configText,
        "text/javascript;charset=utf-8"
    );
});

$("#downloadJson").addEventListener("click", () => {
    if (!state.report || $("#downloadJson").disabled) {
        return;
    }

    downloadFile(
        "report.json",
        JSON.stringify(state.report, null, 4),
        "application/json;charset=utf-8"
    );
});
