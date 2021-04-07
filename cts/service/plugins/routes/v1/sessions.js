/*
    Copyright 2021 Rustici Software

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
"use strict";

const stream = require("stream"),
    Boom = require("@hapi/boom"),
    Wreck = require("@hapi/wreck"),
    { v4: uuidv4 } = require("uuid");

const sessions = {};

module.exports = {
    name: "catapult-cts-api-routes-v1-sessions",
    register: (server, options) => {
        server.decorate(
            "toolkit",
            "sessionEvent",
            (sessionId, event, rawData) => {
                if (sessions[sessionId]) {
                    const data = JSON.stringify(rawData);

                    if (event) {
                        sessions[sessionId].write(`event: ${event}\n`);
                    }

                    sessions[sessionId].write(`data: ${data}\n`);
                    sessions[sessionId].write("\n");
                }
            }
        );

        server.route(
            [
                //
                // not proxying this request because have to alter the body based on
                // converting the CTS course id to the stored Player course id
                //
                {
                    method: "POST",
                    path: "/sessions",
                    handler: async (req, h) => {
                        const db = req.server.app.db,
                            baseUrl = `${req.url.protocol}//${req.url.host}`;

                        let queryResult;

                        try {
                            queryResult = await db
                                .first("*")
                                .from("registrations")
                                .leftJoin("courses", "registrations.course_id", "courses.id")
                                .where("registrations.id", req.payload.testId)
                                .options({nestTables: true});
                        }
                        catch (ex) {
                            throw Boom.internal(new Error(`Failed to retrieve registration for id ${req.payload.testId}: ${ex}`));
                        }

                        if (! queryResult) {
                            throw Boom.notFound(`registration: ${req.payload.testId}`);
                        }

                        let createResponse,
                            createResponseBody;

                        try {
                            createResponse = await Wreck.request(
                                "POST",
                                `${req.server.app.player.baseUrl}/api/v1/courses/${queryResult.courses.player_id}/launch-url/${req.payload.auIndex}`,
                                {
                                    payload: {
                                        reg: queryResult.registrations.code,
                                        actor: queryResult.registrations.metadata.actor
                                    }
                                }
                            );
                            createResponseBody = await Wreck.read(createResponse, {json: true});
                        }
                        catch (ex) {
                            throw Boom.internal(new Error(`Failed to request AU launch url from player: ${ex}`));
                        }

                        if (createResponse.statusCode !== 200) {
                            throw Boom.internal(new Error(`Failed to retrieve AU launch URL (${createResponse.statusCode}): ${createResponseBody.message} (${createResponseBody.srcError})`));
                        }

                        const playerAuLaunchUrl = createResponseBody.url,
                            playerAuLaunchUrlParsed = new URL(playerAuLaunchUrl),
                            playerEndpoint = playerAuLaunchUrlParsed.searchParams.get("endpoint"),
                            playerFetch = playerAuLaunchUrlParsed.searchParams.get("fetch");
                        let sessionId;

                        try {
                            sessionId = await db.insert(
                                {
                                    tenant_id: 1,
                                    player_id: createResponseBody.id,
                                    registration_id: req.payload.testId,
                                    player_au_launch_url: playerAuLaunchUrl,
                                    player_endpoint: playerEndpoint,
                                    player_fetch: playerFetch,
                                    metadata: JSON.stringify({})
                                }
                            ).into("sessions");
                        }
                        catch (ex) {
                            throw Boom.internal(new Error(`Failed to insert into sessions: ${ex}`));
                        }

                        //
                        // swap endpoint, fetch for proxied versions
                        //
                        playerAuLaunchUrlParsed.searchParams.set("endpoint", `${baseUrl}/api/v1/sessions/${sessionId}/lrs`);
                        playerAuLaunchUrlParsed.searchParams.set("fetch", `${baseUrl}/api/v1/sessions/${sessionId}/fetch`);

                        const ctsLaunchUrl = playerAuLaunchUrlParsed.href;
                        const result = await db.first("*").from("sessions").queryContext({jsonCols: ["metadata"]}).where("id", sessionId);

                        delete result.playerId;
                        delete result.playerAuLaunchUrl;
                        delete result.playerEndpoint;
                        delete result.playerFetch;

                        result.launchUrl = ctsLaunchUrl;

                        return result;
                    }
                },

                {
                    method: "GET",
                    path: "/sessions/{id}",
                    handler: async (req, h) => {
                        const result = await req.server.app.db.first("*").from("sessions").queryContext({jsonCols: ["metadata"]}).where("id", req.params.id);

                        if (! result) {
                            return Boom.notFound();
                        }

                        return result;
                    }
                },

                {
                    method: "DELETE",
                    path: "/sessions/{id}",
                    handler: {
                        proxy: {
                            passThrough: true,
                            xforward: true,

                            mapUri: async (req) => {
                                const result = await req.server.app.db.first("playerId").from("courses").where("id", req.params.id);

                                return {
                                    uri: `${req.server.app.player.baseUrl}/api/v1/course/${result.playerId}`
                                };
                            },

                            onResponse: async (err, res, req, h, settings) => {
                                if (err !== null) {
                                    throw new Error(err);
                                }

                                if (res.statusCode !== 204) {
                                    throw new Error(res.statusCode);
                                }
                                const db = req.server.app.db;

                                // clean up the original response
                                res.destroy();

                                let deleteResult;
                                try {
                                    deleteResult = await db("courses").where("id", req.params.id).delete();
                                }
                                catch (ex) {
                                    throw new Error(ex);
                                }

                                return null;
                            }
                        }
                    }
                },

                {
                    method: "GET",
                    path: "/sessions/{id}/events",
                    handler: async (req, h) => {
                        const channel = new stream.PassThrough,
                            response = h.response(channel);

                        sessions[req.params.id] = channel;

                        response.header("Content-Type", "text/event-stream");
                        response.header("Connection", "keep-alive");
                        response.header("Content-Encoding", "identity");
                        response.header("Cache-Control", "no-cache");

                        h.sessionEvent(req.params.id, "control", {kind: "initialize"});

                        req.raw.req.on(
                            "close",
                            () => {
                                h.sessionEvent(req.params.id, "control", {kind: "end"});

                                delete sessions[req.params.id];
                            }
                        );

                        return response;
                    }
                },

                {
                    method: "POST",
                    path: "/sessions/{id}/fetch",
                    handler: async (req, h) => {
                        try {
                            let session;

                            try {
                                session = await req.server.app.db.first("*").from("sessions").queryContext({jsonCols: ["metadata"]}).where("id", req.params.id);
                            }
                            catch (ex) {
                                throw Boom.internal(new Error(`Failed to select session data: ${ex}`));
                            }

                            if (! session) {
                                throw Boom.notFound(`session: ${req.params.id}`);
                            }

                            let fetchResponse,
                                fetchResponseBody;

                            try {
                                fetchResponse = await Wreck.request(
                                    "POST",
                                    session.playerFetch
                                );
                                fetchResponseBody = await Wreck.read(fetchResponse, {json: true});
                            }
                            catch (ex) {
                                throw Boom.internal(new Error(`Failed to request fetch url from player: ${ex}`));
                            }

                            h.sessionEvent(req.params.id, null, {kind: "spec", resource: "fetch", playerResponseStatusCode: fetchResponse.statusCode});

                            return h.response(fetchResponseBody).code(fetchResponse.statusCode);
                        }
                        catch (ex) {
                            return h.response(
                                {
                                    "error-code": "3",
                                    "error-text": `General Application Error: ${ex}`
                                }
                            ).code(400);
                        }
                    }
                },

                //
                // proxy the LRS based on the session identifier so that the service
                // knows what session to log information for
                //
                {
                    method: [
                        "GET",
                        "POST",
                        "PUT",
                        "DELETE",
                        "OPTIONS"
                    ],
                    path: "/sessions/{id}/lrs/{resource*}",
                    options: {
                        //
                        // turn off CORS for this handler because the LRS will provide back the right headers
                        // this just needs to pass them through, enabling CORS for this route means they get
                        // overwritten by the Hapi handling
                        //
                        cors: false,

                        //
                        // set up a pre-request handler to handle capturing meta information about the xAPI
                        // requests before proxying the request to the underlying LRS (which is proxied from
                        // the player)
                        //
                        pre: [
                            async (req, h) => {
                                let session;

                                try {
                                    session = await req.server.app.db.first("*").from("sessions").queryContext({jsonCols: ["metadata"]}).where("id", req.params.id);
                                }
                                catch (ex) {
                                    throw Boom.internal(new Error(`Failed to select session data: ${ex}`));
                                }

                                if (! session) {
                                    throw Boom.notFound(`session: ${req.params.id}`);
                                }

                                if (req.method !== "options") {
                                    h.sessionEvent(req.params.id, null, {kind: "lrs", method: req.method, resource: req.params.resource});
                                }

                                return null;
                            }
                        ]
                    },
                    handler: {
                        proxy: {
                            passThrough: true,
                            xforward: true,

                            //
                            // map the requested resource (i.e. "statements" or "activities/state") from the
                            // provided LRS endpoint to the resource at the underlying LRS endpoint, while
                            // maintaining any query string parameters
                            //
                            mapUri: (req) => ({
                                uri: `${req.server.app.player.baseUrl}/lrs/${req.params.resource}${req.url.search}`
                            }),

                            //
                            // hook into the response provided back from the LRS to capture details such as
                            // the status code, error messages, etc.
                            //
                            onResponse: async (err, res, req, h, settings) => {
                                if (err !== null) {
                                    throw new Error(`LRS request failed: ${err}`);
                                }

                                const payload = await Wreck.read(res),
                                    response = h.response(payload);

                                response.code(res.statusCode);
                                response.message(res.statusMessage);

                                for (const [k, v] of Object.entries(res.headers)) {
                                    if (k.toLowerCase() !== "transfer-encoding") {
                                        response.header(k, v);
                                    }
                                }

                                // clean up the original response
                                res.destroy();

                                return response;
                            }
                        }
                    }
                }
            ]
        );
    }
};
