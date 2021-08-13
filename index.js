/*
 * ITINERARY BACKEND SERVER REST API
 * 
 * This is the REST API server for Itinerary. It handles account operations and communicates with the MongoDB database.
 * 
 * CREDITS:
 *   - Jeffalo for most of the authentication code
 *   - ScratchDB for verifying username cases
 *   - StackOverflow for complicated algorithms (see comments above specific functions)
*/

/*
 * TODO:
 *   - Handle bad requests such as ones with plain % parameters
 *   - Add CRUD endpoints for Scratch Game Jams
 *   - Tidy up and eliminate duplicate code
 *   - Better and more consistent error handling
*/

require('dotenv').config();
const fetch = require('node-fetch');
const crypto = require('crypto');

const express = require('express');

// Import Mongoose and the `Users` and `Sessions` models
const mongoose = require('mongoose');
const Users = require('./models/users');
const Sessions = require('./models/sessions');
const Jams = require('./models/jams');

// Make sure to not use deprecated features
mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);
mongoose.set('useCreateIndex', true);
mongoose.set('useUnifiedTopology', true);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URL).then(() => {
    console.log('Connected to MongoDB!');
}).catch((error) => {
    console.log(`Failed to connect to MongoDB! Error: ${error}`);
});

const app = express();
const port = 8081;

let cors = require('cors');

const whitelist = ['http://localhost:3000', 'http://localhost:8081', process.env.FRONTEND_URL, process.env.BACKEND_URL];
const frontendURL = process.env.FRONTEND_URL;

const corsOptions = {
    origin: function (origin, callback) {
        if (whitelist.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
};

// Use built-in middleware to recognize incoming request objects as JSON objects
app.use(express.json());

// Default response to root queries
app.get('/', async (req, res) => {
    res.json({ meta: { version: 'v1', time: new Date() } });
});

/*
 * General and user management endpoints
*/
app.options('/api/users', cors(corsOptions));

app.get('/api/users', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.json({ error: 'Authentication needed!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);

        if (!sessionUser.admin) {
            return res.json({ error: `Only admins can get a list of users!` });
        }
        let userList = await Users.find({}).sort({ "meta.updated": -1, _id: -1 }).exec();
        res.json(userList);
    }
});

app.options('/api/user/:name', cors(corsOptions));

app.put('/api/user/:name', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        res.json({ error: 'You need auth!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.json({ error: 'Invalid auth!' });
        };

        let sessionUser = await getUserData(session.name);

        if (session.name.toLowerCase() !== req.params.name.toLowerCase() && !sessionUser.admin) {
            return res.json({ error: "You cannot edit other users unless you are an admin!" });
        };

        let user = await getUserData(req.params.name);

        if (user) {
            if (user.banned && !sessionUser.admin) return res.status(403).json({ error: { status: 403, code: "banned", detail: "You are banned from Itinerary!" } });
            if (!req.params) {
                return res.json({ error: { status: 400, code: 'userAlreadyExists', detail: 'This user already exists. If you are trying to update their account, please don\'t forget to send the necessary request parameters!' } });
            }
            let now = new Date();

            if (sessionUser.admin) {
                // Ban user
                if (req.body.banned) {
                    await Users.updateOne({ name: user.name }, { $set: { banned: req.body.banned } });
                    await Sessions.deleteOne({ name: user.name });
                } else {
                    await Users.updateOne({ name: user.name }, { $unset: { banned: "" } });
                };

                // Promote/demote user
                if (req.body.admin) {
                    await Users.updateOne({ name: user.name }, { $set: { admin: req.body.admin } });
                } else {
                    await Users.updateOne({ name: user.name }, { $unset: { admin: "" } });
                };
            };

            await Users.updateOne({ name: user.name }, { $set: { "meta.updatedBy": sessionUser.name, "meta.updated": now.toISOString() } });

            res.json({ ok: 'User updated!' });
        } else {
            if (req.params.name) {
                // This is an admin trying to update a non-existent user thus we should create that user.

                // Get the proper case of the username instead of whatever admin inputted
                let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${req.params.name}/`);
                let scratchData = await scratchResponse.json();

                if (!scratchData.username) {
                    return res.json({ error: { status: 404, code: 'userNotFound', detail: 'This user could not be found on Scratch.' } });
                };

                let now = new Date();

                await Users.create({
                    name: scratchData.username,
                    meta: {
                        updated: now.toISOString(),
                        updatedBy: session.name
                    }
                });
                res.json({ ok: 'User added!' });
            } else {
                return res.json({ error: { status: 400, code: 'missingParameters', detail: 'You must enter a username!' } });
            }
        };
    };
});

app.delete('/api/user/:name', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.json({ error: 'You need auth!' });
    };

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.json({ error: 'Invalid auth!' });
    };

    let sessionUser = await getUserData(session.name);

    if (!sessionUser.admin) {
        if (session.name.toLowerCase() !== req.params.name.toLowerCase()) {
            return res.status(403).json({ error: { status: 403, code: "insufficientPermissions", detail: "This action can only be performed by an admin or the account owner!" } });
        }
    };

    let user = await getUserData(req.params.name);

    if (!user) {
        return res.json({ error: "This user could not be deleted because it doesn't exist!" });
    };

    await Sessions.deleteOne({ name: user.name });
    await Users.deleteOne({ name: user.name });
    res.json({ ok: 'This user has been successfully deleted!' });
});

app.get('/api/user/:user/picture', cors(corsOptions), async (req, res) => {
    let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${req.params.user}/`);
    let scratchData = await scratchResponse.json();
    let pictureURL = 'https://cdn2.scratch.mit.edu/get_image/user/0_90x90.png';
    if (scratchData.profile) pictureURL = scratchData.profile.images['90x90'];
    res.redirect(pictureURL);
});
/* --------------- */


/*
 * Game jam endpoints
*/
app.get('/api/jams/:jam?', cors(), async (req, res) => {
    // Parse `bypassMystery` URL parameter
    const bypassMystery = (req.query.bypassMystery === 'true');

    if (!req.params.jam) {
        // If we are NOT looking for a specific jam
        const limit = req.query.limit;

        // Get an array of all jams
        let jamsList = await Jams.find({}).sort({ 'dates.start': 'descending' }).lean().exec();

        // Loop through all jams and hide the title and main theme of jams that didn't start yet
        if (bypassMystery) {
            if (!req.headers.authorization) {
                res.json({ error: 'Authentication needed!' });
            } else {
                let session = findSession(req.headers.authorization);

                if (!session) {
                    return res.json({ error: 'Invalid auth!' });
                }

                let sessionUser = await getUserData(session.name);

                if (!sessionUser.admin) {
                    return res.json({ error: `Only admins can view the details of upcoming jams!` });
                }
            }
        } else {
            for (var i = 0; i < jamsList.length; i++) {
                console.log(`JAM DATE: ${new Date(jamsList[i]['dates']['start'])}, CURRENT DATE: ${new Date()}`);
                if (new Date(jamsList[i]['dates']['start']) > new Date()) {
                    // This jam is scheduled to start in the future. Therefore, we hide all content that could allow users to get an unfair head start
                    jamsList[i]['mystery'] = true;
                    delete jamsList[i]['content']['body'];
                    delete jamsList[i]['content']['colors'];
                    delete jamsList[i]['content']['headerImage'];
                } else {
                    jamsList[i]['mystery'] = false;
                }
            };
        }

        if (!limit) {
            // Return all jams
            res.json(jamsList);
        } else {
            // Return a maximum of `limit` jams
            res.json(jamsList.slice(0, limit));
        }
    } else {
        // If we are looking for a specific jam
        let jam = await Jams.findOne({ slug: req.params.jam }).lean();

        if (jam) {
            // Loop through all jams and hide the title and main theme of jams that didn't start yet
            if (bypassMystery) {
                if (!req.headers.authorization) {
                    res.json({ error: 'Authentication needed!' });
                } else {
                    let session = findSession(req.headers.authorization);

                    if (!session) {
                        return res.json({ error: 'Invalid auth!' });
                    }

                    let sessionUser = await getUserData(session.name);

                    if (!sessionUser.admin) {
                        return res.json({ error: `Only admins can view the details of upcoming jams!` });
                    }
                }
            } else {
                if (new Date(jam['dates']['start']) > new Date()) {
                    // This jam is scheduled to start in the future. Therefore, we hide all content that could allow users to get an unfair head start
                    jam['mystery'] = true;
                    delete jam['content']['body'];
                    delete jam['content']['colors'];
                    delete jam['content']['headerImage'];
                } else {
                    jam['mystery'] = false;
                }
            }
            return res.json(jam);
        } else {
            return res.json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
        }
    }
});

app.put('/api/jams/:jam?', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        res.json({ error: 'You need auth!' });
    } else {
        // Check whether the session is valid and the user has admin privileges
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.json({ error: 'Invalid auth!' });
        };

        let sessionUser = await getUserData(session.name);

        if (!sessionUser.admin) {
            return res.status(403).json({ error: { status: 403, code: "insufficientPermissions", detail: "This action can only be performed by an admin!" } });
        };

        if (!req.params.jam) {
            // An admin is attempting to create a new jam
            let record = req.body;
            let now = new Date();
            let meta = {
                meta: {
                    updated: now.toISOString(),
                    updatedBy: session.name
                }
            };
            // Append the `meta` object to the record
            record = { ...record, ...meta };
            // Create the new jam using
            Jams.create(record)
                .then(() => {
                    return res.json({ ok: 'The jam was successfully created!' });
                })
                .catch((e) => {
                    console.log(e);
                    return res.json({ error: { status: 400, code: 'missingParameters', detail: 'One or more required parameters are missing from your query!' } });
                });
        } else {
            // An admin is attempting to update a specific jam

            let now = new Date();
            // We are using the optional chaining operator (?.) to avoid errors when a specific property of the request body is undefined, as we will filter it later
            let updateQuery = {
                name: req?.body?.name,
                dates: {
                    start: req?.body?.dates?.start,
                    end: req?.body?.dates?.end,
                    votingStart: req?.body?.dates?.votingStart,
                    votingEnd: req?.body?.dates?.votingEnd,
                },
                content: {
                    headerImage: req?.body?.content?.headerImage,
                    colors: req?.body?.content?.colors,
                    description: req?.body?.content?.description,
                    body: req?.body?.content?.body
                },
                options: {
                    showSubmissionsBeforeVoting: req?.body?.options?.showSubmissionsBeforeVoting
                },
                meta: {
                    updated: now.toISOString(),
                    updatedBy: session.name
                }
            };
            // Remove `undefined` and non-object values but keep `null`s, hence the `true` parameter
            updateQuery = cleanObject(updateQuery, true);
            // Retrieve the current jam and merge it with the cleaned, new jam
            let jam = await Jams.findOne({ slug: req.params.jam }).lean();
            if (!jam) {
                return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
            }
            updateQuery = mergeObjects(jam, updateQuery);
            // Update the jam and return the new slug
            await Jams.findOneAndUpdate({ slug: req.params.jam }, { $set: updateQuery }, { new: true }).then(updatedDocument => {
                if (updatedDocument) {
                    return res.status(200).json({ ok: { newSlug: updatedDocument.slug } });
                } else {
                    return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
                }
            });
        }
    }
});

app.delete('/api/jams/:jam', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.json({ error: 'You need auth!' });
    };

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.json({ error: 'Invalid auth!' });
    };

    let sessionUser = await getUserData(session.name);

    if (!sessionUser.admin) {
        return res.status(403).json({ error: { status: 403, code: "insufficientPermissions", detail: "This action can only be performed by an admin!" } });
    };

    // Delete jam and all submissions associated with it
    let jam = await Jams.findOne({ slug: req.params.jam });
    if (jam) {
        await Jams.deleteOne({ slug: req.params.jam });
    } else {
        return res.json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
    }
    res.json({ ok: 'This jam has been successfully deleted!' });
});
/* --------------- */


/*
 * Authentication endpoints
*/
app.get('/auth/begin', (req, res) => {
    let redirect;
    if (req.get('host') == 'localhost:8081') {
        redirect = 'localhost:8081/auth/handle';
    } else {
        redirect = `${process.env.BACKEND_URL.replace(/(^\w+:|^)\/\//, '')}/auth/handle`;
    };
    redirect = Buffer.from(redirect).toString('base64');
    res.redirect(`https://fluffyscratch.hampton.pw/auth/getKeys/v2?redirect=${redirect}`);
});

app.get('/auth/handle', async (req, res) => {
    // The user is back from Hampton's authentication service
    const private = req.query.privateCode;

    let authResponse = await fetch('https://fluffyscratch.hampton.pw/auth/verify/v2/' + private)
        .catch(e => {
            console.log(e);
            return res.redirect(`${frontendURL}/login?error=${1}`);
        });

    let authData = await authResponse.json();

    if (authData.valid) {
        // Get the proper case of the username instead of URL case

        let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${authData.username}/`)
            .catch(e => {
                console.log(e);
                return res.redirect(`${frontendURL}/login?error=${1}`);
            });
        let scratchData = await scratchResponse.json();

        if (!scratchData.username) {
            return res.json({ error: { status: 404, code: 'userNotFound', detail: 'This user could not be found on Scratch.' } });
        }

        let foundUser = await getUserData(scratchData.username);

        if (!foundUser) {
            let now = new Date();
            foundUser = await Users.create({
                name: scratchData.username,
                meta: {
                    updated: now.toISOString(),
                    updatedBy: null
                }
            });
        }

        if (!foundUser.banned) {
            const token = await generateToken();
            const oneTimeToken = await generateToken();
            addSession(token, scratchData.username, oneTimeToken);

            res.redirect(`${frontendURL}/confirm-login?token=${oneTimeToken}`);
        } else {
            // This user is banned
            res.redirect(`${frontendURL}/login?error=${2}`);
        }
    } else {
        // Failed FluffyScratch auth
        res.redirect(`${frontendURL}/login?error=${0}`);
    }
});

app.get('/auth/info', cors(corsOptions), async (req, res) => {
    if (req.query.token) {
        let session = findSessionByOneTimeToken(req.query.token);
        if (session) {
            res.json({ name: session.name, token: session.token });
            await Sessions.updateOne({ oneTimeToken: req.query.token }, { $set: { oneTimeToken: null } });
            session.oneTimeToken = null;
        } else {
            res.json({ error: 'No session found! Invalid or expired one time token.' });
        }
    } else {
        res.json({ error: 'Requires query parameter token' });
    }
});

// Used when logging out or cancelling login
// Discards the session
app.post('/auth/remove', cors(corsOptions), async (req, res) => {
    if (req.query.token) {
        let session = findSession(req.query.token);
        if (session) {
            let name = session.name;
            removeSession(req.query.token);
            res.json({ ok: `Removed session for ${name}` });
        } else {
            res.json({ error: 'The session from the token is already invalid/expired!' });
        }
    } else {
        res.json({ error: 'Requires query parameter token' });
    }
});

app.options('/auth/me', cors(corsOptions));

app.get('/auth/me', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.json({ error: 'you need auth' });
    } else {
        let session = findSession(req.headers.authorization);
        if (!session) {
            return res.status(403).json({ error: { status: 403, code: 'invalidAuth', detail: 'Invalid auth!' } });
        }
        let user = await getUserData(session.name);
        if (user.banned) {
            res.status(403).json({ error: { status: 403, code: "banned", detail: "You are banned from Itinerary!", name: user.name } });
        }
        user ? res.json(user) : res.json({ error: "no user found.. this shouldn't happen" });
    }
});
/* --------------- */


// Handle 404 errors
app.all('*', (req, res) => {
    res.status(404).json({ error: { status: 404, code: 'notFound', detail: 'The requested resource or path could not be found.' } });
});


/*
 * Utility functions
*/
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function getUserData(name) {
    var regexName = "^" + escapeRegExp(name) + "$";
    return new Promise(async (resolve, reject) => {
        try {
            var user = await Users.findOne({
                name: { $regex: new RegExp(regexName, "i") }
            });
            resolve(user);
        } catch (error) {
            reject(Error(error));
        }
    });
}

// Modified version of https://stackoverflow.com/a/52368116/14226941
function cleanObject(object, keepNull = false) {
    Object
        .entries(object)
        .forEach(([k, v]) => {
            if (v && typeof v === 'object') {
                cleanObject(v, keepNull);
            }
            if (keepNull) {
                if (v && typeof v === 'object' && !Object.keys(v).length || v === null || v === undefined) {
                    if (Array.isArray(object)) {
                        object.splice(k, 1);
                    } else {
                        delete object[k];
                    }
                }
            } else {
                if (v && typeof v === 'object' && !Object.keys(v).length || v === undefined) {
                    if (Array.isArray(object)) {
                        object.splice(k, 1);
                    } else {
                        delete object[k];
                    }
                }
            }
        });
    return object;
}

// Function taken from https://gist.github.com/ahtcx/0cd94e62691f539160b32ecda18af3d6
function mergeObjects(target, source) {
    // Iterate through `source` properties and if an `Object` set property to merge of `target` and `source` properties
    for (const key of Object.keys(source)) {
        if (source[key] instanceof Object) Object.assign(source[key], mergeObjects(target[key], source[key]));
    }

    // Join `target` and modified `source`
    Object.assign(target || {}, source);
    return target;
}
/* --------------- */


/*
 * Session management
*/
let sessions = [];

(async () => {
    sessions = await Sessions.find({});
})();

async function generateToken() {
    const buffer = await new Promise((resolve, reject) => {
        crypto.randomBytes(256, function (ex, buffer) {
            if (ex) {
                reject("Failed to generate token.");
            }
            resolve(buffer);
        });
    });
    const token = crypto
        .createHash("sha1")
        .update(buffer)
        .digest("hex");

    return token;
};

async function addSession(token, name, oneTimeToken, time = false) {
    // Defaults to 6 hours

    sessions.push({ name, token, oneTimeToken });
    await Sessions.create({ name, token, oneTimeToken });

    if (time) {
        setTimeout(() => {
            // Remove token after time seconds
            removeSession(token);
        }, time);
    }
}

async function removeSession(token) {
    sessions = sessions.filter(obj => {
        return obj.token !== token;
    });
    await Sessions.deleteOne({ token });
}

function findSession(token) {
    const session = sessions.find(f => f.token == token);
    return session;
}

function findSessionByOneTimeToken(oneTimeToken) {
    const session = sessions.find(f => f.oneTimeToken == oneTimeToken);
    return session;
}
/* --------------- */

app.listen(port, () => {
    console.log(`Listening on port ${port}...`);
});