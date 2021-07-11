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

const Bcrypt = require("bcrypt"),
    Joi = require("joi"),
    Boom = require("@hapi/boom"),
    Wreck = require("@hapi/wreck"),
    getClientSafeUser = (user) => {
        delete user.password;
        delete user.playerApiToken;
        delete user.tenantId;

        return user;
    },
    createUser = async (username, password, roles, {req}) => {
        //
        // need to create a tenant in the player
        //
        let createTenantResponse,
            createTenantResponseBody;

        try {
            createTenantResponse = await Wreck.request(
                "POST",
                `${req.server.app.player.baseUrl}/api/v1/tenant`,
                {
                    headers: {
                        Authorization: await req.server.methods.playerBasicAuthHeader(req)
                    },
                    payload: {
                        code: username
                    }
                }
            );
            createTenantResponseBody = await Wreck.read(createTenantResponse, {json: true});
        }
        catch (ex) {
            throw Boom.internal(new Error(`Failed request to create player tenant: ${ex}`));
        }

        if (createTenantResponse.statusCode !== 200) {
            throw Boom.internal(new Error(`Failed to create player tenant (${createTenantResponse.statusCode}): ${createTenantResponseBody.message}${createTenantResponseBody.srcError ? " (" + createTenantResponseBody.srcError + ")" : ""}`));
        }

        const playerTenantId = createTenantResponseBody.id;

        //
        // with the tenant created get a token for this user to use
        // to access the player API for that tenant
        //
        let createTokenResponse,
            createTokenResponseBody;

        try {
            createTokenResponse = await Wreck.request(
                "POST",
                `${req.server.app.player.baseUrl}/api/v1/auth`,
                {
                    headers: {
                        Authorization: await req.server.methods.playerBasicAuthHeader(req)
                    },
                    payload: {
                        tenantId: playerTenantId,
                        audience: `cts-${username}`
                    }
                }
            );
            createTokenResponseBody = await Wreck.read(createTokenResponse, {json: true});
        }
        catch (ex) {
            throw Boom.internal(new Error(`Failed request to create player tenant: ${ex}`));
        }

        if (createTokenResponse.statusCode !== 200) {
            throw Boom.internal(new Error(`Failed to retrieve player token (${createTokenResponse.statusCode}): ${createTokenResponseBody.message}${createTokenResponseBody.srcError ? " (" + createTokenResponseBody.srcError + ")" : ""}`));
        }

        const playerApiToken = createTokenResponseBody.token;

        let userId,
            tenantId;

        await req.server.app.db.transaction(
            async (txn) => {
                //
                // create a tenant for this user
                //
                try {
                    const insertResult = await txn.insert(
                        {
                            code: `user-${username}`,
                            playerTenantId
                        }
                    ).into("tenants");

                    tenantId = insertResult[0];
                }
                catch (ex) {
                    throw new Error(`Failed to insert tenant: ${ex}`);
                }

                //
                // finally create the user which contains the token needed to access
                // the player API
                //
                try {
                    const insertResult = await txn.insert(
                        {
                            tenantId,
                            username: username,
                            password: await Bcrypt.hash(password, 8),
                            playerApiToken,
                            roles: JSON.stringify(roles)
                        }
                    ).into("users");

                    userId = insertResult[0];
                }
                catch (ex) {
                    throw Boom.internal(new Error(`Failed to insert into users: ${ex}`));
                }
            }
        );

        return {userId, tenantId};
    };

module.exports = {
    name: "catapult-cts-api-routes-v1-core",
    register: (server, options) => {
        server.route(
            [
                //
                // this route is mainly used to check whether or not a cookie provides for valid
                // authentication, and in the case it does it will return information about the
                // user which allows for automatic login in the web UI client
                //
                // it also acts as the initial request whenever the UI is loaded so use it to
                // check to make sure the site has been initialized and that at least one user
                // exists
                //
                {
                    method: "GET",
                    path: "/login",
                    options: {
                        auth: {
                            mode: "try"
                        },
                        tags: ["api"]
                    },
                    handler: async (req, h) => {
                        const db = req.server.app.db,
                            responseBody = {};
                        let responseStatus;

                        if (req.auth.isAuthenticated) {
                            responseStatus = 200;

                            let user;

                            try {
                                user = await db.first("*").from("users").queryContext({jsonCols: ["roles"]}).where({id: req.auth.credentials.id});
                            }
                            catch (ex) {
                                throw Boom.internal(new Error(`Failed to retrieve user for id ${req.auth.credentials.id}: ${ex}`));
                            }

                            responseBody.isBootstrapped = true;
                            responseBody.user = getClientSafeUser(user);
                        }
                        else {
                            responseStatus = 401;

                            //
                            // check to make sure there is at least one user in the users table
                            //
                            const [query] = await db("users").count("id", {as: "count"});

                            responseBody.isBootstrapped = query.count > 0;
                        }

                        return h.response(responseBody).code(responseStatus);
                    }
                },

                //
                // this route allows authenticating by username/password and then optionally
                // provides a cookie to prevent the need to continue to use basic auth
                //
                {
                    method: "POST",
                    path: "/login",
                    options: {
                        auth: false,
                        tags: ["api"],
                        validate: {
                            payload: Joi.object({
                                username: Joi.string().required(),
                                password: Joi.string().required(),
                                storeCookie: Joi.boolean().optional()
                            }).label("Request-Login")
                        }
                    },
                    handler: async (req, h) => {
                        let user;

                        try {
                            user = await req.server.app.db.first("*").from("users").queryContext({jsonCols: ["roles"]}).where({username: req.payload.username});
                        }
                        catch (ex) {
                            throw Boom.internal(new Error(`Failed to retrieve user for username ${req.payload.username}: ${ex}`));
                        }

                        if (! user || ! await Bcrypt.compare(req.payload.password, user.password)) {
                            throw Boom.unauthorized();
                        }

                        if (req.payload.storeCookie) {
                            req.cookieAuth.set(await req.server.methods.getCredentials(user));
                        }

                        return getClientSafeUser(user);
                    }
                },

                //
                // this route simply removes any previously stored auth cookie
                //
                {
                    method: "GET",
                    path: "/logout",
                    options: {
                        auth: false,
                        tags: ["api"]
                    },
                    handler: async (req, h) => {
                        req.cookieAuth.clear();

                        return null;
                    }
                },

                //
                // this route is used to establish the first user in the database and can't
                // be accessed once users exist in the DB, it is intended to make it easy
                // to establish deployments that are unique to few users
                //
                {
                    method: "POST",
                    path: "/bootstrap",
                    options: {
                        tags: ["api"],
                        auth: false,
                        validate: {
                            payload: Joi.object({
                                firstUser: Joi.object({
                                    username: Joi.string().required(),
                                    password: Joi.string().required()
                                }).required()
                            }).label("Request-Bootstrap")
                        }
                    },
                    handler: async (req, h) => {
                        const db = req.server.app.db,
                            //
                            // checking that there aren't any users created yet is effectively
                            // the authorization for this resource
                            //
                            [query] = await db("users").count("id", {as: "count"});

                        if (query.count > 0) {
                            throw Boom.conflict(`Unexpected user count: ${query.count}`);
                        }

                        try {
                            // the first user has to be an admin so they can handle other users being created
                            await createUser(req.payload.firstUser.username, req.payload.firstUser.password, ["admin", "user"], {req});
                        }
                        catch (ex) {
                            throw Boom.internal(`Failed to create user: ${ex}`);
                        }

                        return null;
                    }
                }
            ]
        );
    }
};
