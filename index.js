/*
 * ITINERARY BACKEND SERVER REST API
 * 
 * This is the REST API server for Itinerary. It handles account operations and communicates with the MongoDB database.
 * 
 * CREDITS:
 *   - Jeffalo for most of the authentication code
*/

/*
 * TODO:
 *   - Handle bad requests such as ones with plain % parameters
 *   - Add CRUD endoints for Scratch Game Jams
*/

require('dotenv').config();
const fetch = require('node-fetch')
const crypto = require('crypto');

const express = require('express');

// Import Mongoose and the `Users` and `Sessions` models
const mongoose = require('mongoose');
const Users = require('./models/users');
const Sessions = require('./models/sessions');

// Make sure to not use deprecated features
mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);
mongoose.set('useCreateIndex', true);
mongoose.set('useUnifiedTopology', true);

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URL);

const app = express();
const port = 8081;

let cors = require('cors');

const whitelist = ['http://localhost:3000', 'http://localhost:8081', process.env.FRONTEND_URL, process.env.BACKEND_URL];
const frontendURL = process.env.FRONTEND_URL;

const corsOptions = {
    origin: function (origin, callback) {
        if (whitelist.indexOf(origin) !== -1 || !origin) {
            callback(null, true)
        } else {
            callback(new Error('Not allowed by CORS'))
        }
    },
}

// Use built-in middleware to recognize incoming request objects as JSON objects
app.use(express.json());

// Default response to root queries
app.get('/', async (req, res) => {
    res.json({ meta: { version: 'v1', time: new Date() } });
});

app.options('/api/users', cors(corsOptions));

app.get('/api/users', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.json({ error: 'Authentication needed!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name)

        if (!sessionUser.admin) {
            return res.json({ error: `Only admins can get a list of users!` });
        }
        let userList = await Users.find({}).sort({ "meta.updated": -1, _id: -1 }).exec();
        res.json(userList);
    }
})

app.options('/api/user/:name', cors(corsOptions));

app.put('/api/user/:name', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        res.json({ error: 'You need auth!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.json({ error: 'Invalid auth!' });
        };

        let sessionUser = await getUserData(session.name)

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
    const private = req.query.privateCode

    let authResponse = await fetch('https://fluffyscratch.hampton.pw/auth/verify/v2/' + private)
    let authData = await authResponse.json()

    if (authData.valid) {
        // Get the proper case of the username instead of URL case

        let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${authData.username}/`)
        let scratchData = await scratchResponse.json()

        if (!scratchData.username) {
            return res.json({ error: { status: 404, code: 'userNotFound', detail: 'This user could not be found on Scratch.' } })
        }

        let foundUser = await getUserData(scratchData.username)

        if (!foundUser) {
            let now = new Date()
            foundUser = await Users.create({
                name: scratchData.username,
                meta: {
                    updated: now.toISOString(),
                    updatedBy: null
                }
            })
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
        // Failed Fluffyscratch auth
        res.redirect(`${frontendURL}/login?error=${0}`);
    }
});

app.get('/auth/info', cors(corsOptions), async (req, res) => {
    if (req.query.token) {
        let session = findSessionByOneTimeToken(req.query.token)
        if (session) {
            res.json({ name: session.name, token: session.token })
            await Sessions.updateOne({ oneTimeToken: req.query.token }, { $set: { oneTimeToken: null } })
            session.oneTimeToken = null
        } else {
            res.json({ error: 'No session found! Invalid or expired one time token.' })
        }
    } else {
        res.json({ error: 'Requires query parameter token' })
    }
})

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
})

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
})

// Handle 404 errors
app.all('*', (req, res) => {
    res.status(404).json({ error: { status: 404, code: 'notFound', detail: 'The requested resource or path could not be found.' } });
});

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
    })
}

// Session management
let sessions = [];

(async () => {
    sessions = await Sessions.find({})
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
    })
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

app.listen(port, () => {
    console.log(`Listening on port ${port}...`);
});