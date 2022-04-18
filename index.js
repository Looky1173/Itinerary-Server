/*
 * ITINERARY BACKEND SERVER (REST API)
 *
 * This is the REST API server for Itinerary. It handles account operations and communicates with the MongoDB database.
 *
 * CREDITS:
 *   - Jeffalo for most of the authentication code
 *   - ScratchDB for verifying username cases
 *   - FluffyScratch for authentication
 *   - StackOverflow for complicated algorithms (see comments above specific functions)
 */

/*
 * TODO:
 *   - Handle bad requests such as ones with plain % parameters
 *   - Tidy up and eliminate duplicate code; eliminate unnecessary indents because of if/else statements
 *   - Better and more consistent error handling
 *   - Add middleware for blocking requests from banned users
 *   - Validate game jam dates before saving them
 *   - Implement better pagination for game jams and projects
 *   - Support ordering projects by various criteria
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
const Projects = require('./models/projects');
const Upvotes = require('./models/upvotes');
const Managers = require('./models/managers');

// Make sure to not use deprecated features
mongoose.set('useNewUrlParser', true);
mongoose.set('useFindAndModify', false);
mongoose.set('useCreateIndex', true);
mongoose.set('useUnifiedTopology', true);

// Connect to MongoDB
mongoose
    .connect(process.env.MONGO_URL)
    .then(() => {
        console.log('Connected to MongoDB!');
    })
    .catch((error) => {
        console.log(`Failed to connect to MongoDB! Error: ${error}`);
    });

const app = express();
const port = 8081;

let cors = require('cors');

const whitelist = ['http://localhost:3000', 'http://localhost:8081', process.env.FRONTEND_URL, process.env.BACKEND_URL];
const frontendURL = process.env.FRONTEND_URL;

const MAX_UPVOTES_PER_JAM = 3;

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
    res.status(200).json({ meta: { version: 'v1', time: new Date() } });
});

/*
 * General and user management endpoints
 */
app.options('/api/users', cors(corsOptions));

app.get('/api/users', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'Authentication needed!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);

        if (!sessionUser.admin) {
            return res.status(403).json({ error: `Only admins can get a list of users!` });
        }
        let userList = await Users.find({}).sort({ 'meta.updated': -1, _id: -1 }).exec();
        res.status(200).json(userList);
    }
});

app.options('/api/user/:name', cors(corsOptions));

app.put('/api/user/:name', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'You need auth!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);

        if (session.name.toLowerCase() !== req.params.name.toLowerCase() && !sessionUser.admin) {
            return res.status(403).json({ error: 'You cannot edit other users unless you are an admin!' });
        }

        let user = await getUserData(req.params.name);

        if (user) {
            if (user.banned && !sessionUser.admin) return res.status(403).json({ error: { status: 403, code: 'banned', detail: 'You are banned from Itinerary!' } });
            if (!req.params) {
                return res.status(400).json({
                    error: {
                        status: 400,
                        code: 'userAlreadyExists',
                        detail: "This user already exists. If you are trying to update their account, please don't forget to send the necessary request parameters!",
                    },
                });
            }
            let now = new Date();

            if (sessionUser.admin) {
                // Ban user
                if (req.body.banned) {
                    await Users.updateOne({ name: user.name }, { $set: { banned: req.body.banned } });
                    await Sessions.deleteOne({ name: user.name });
                } else {
                    await Users.updateOne({ name: user.name }, { $unset: { banned: '' } });
                }

                // Promote/demote user
                if (req.body.admin) {
                    await Users.updateOne({ name: user.name }, { $set: { admin: req.body.admin } });
                } else {
                    await Users.updateOne({ name: user.name }, { $unset: { admin: '' } });
                }
            }

            await Users.updateOne({ name: user.name }, { $set: { 'meta.updatedBy': sessionUser.name, 'meta.updated': now.toISOString() } });

            res.status(200).json({ ok: 'User updated!' });
        } else {
            if (req.params.name) {
                // This is an admin trying to update a non-existent user thus we should create that user.

                // Get the proper case of the username instead of whatever admin inputted
                let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${req.params.name}/`);
                let scratchData = await scratchResponse.json();

                if (!scratchData.username) {
                    return res.status(404).json({ error: { status: 404, code: 'userNotFound', detail: 'This user could not be found on Scratch.' } });
                }

                let now = new Date();

                await Users.create({
                    name: scratchData.username,
                    meta: {
                        updated: now.toISOString(),
                        updatedBy: session.name,
                    },
                });
                res.status(200).json({ ok: 'User added!' });
            } else {
                return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'You must enter a username!' } });
            }
        }
    }
});

app.delete('/api/user/:name', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    let sessionUser = await getUserData(session.name);

    if (!sessionUser.admin) {
        if (session.name.toLowerCase() !== req.params.name.toLowerCase()) {
            return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or the account owner!' } });
        }
    }

    let user = await getUserData(req.params.name);

    if (!user) {
        return res.status(404).json({ error: "This user could not be deleted because it doesn't exist!" });
    }

    await Sessions.deleteOne({ name: user.name });
    await Users.deleteOne({ name: user.name });
    res.status(200).json({ ok: 'This user has been successfully deleted!' });
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
app.options('/api/jams/:jam?', cors(corsOptions));

app.get('/api/jams/:jam?', cors(corsOptions), async (req, res) => {
    // Parse `bypassMystery` URL parameter
    const bypassMystery = req.query.bypassMystery === 'true';

    if (!req.params.jam) {
        // If we are NOT looking for a specific jam
        const limit = req.query.limit || 40;
        let offset = req.query.offset || 0;
        if (offset < 0) offset = 0;

        const { featured } = req.query;
        let filterQuery = {};
        if (featured != null || featured != undefined) {
            if (featured == 'true') {
                filterQuery.featured = true;
            } else {
                filterQuery.featured = { $ne: true };
            }
        }

        // Get an array of all jams
        let jamsCount = await Jams.countDocuments({});
        let jamsList = await Jams.find(filterQuery).sort({ 'dates.start': 'descending' }).skip(Number(offset)).limit(Number(limit)).lean().exec();

        // Loop through all jams and hide the title and main theme of jams that didn't start yet
        if (bypassMystery) {
            if (!req.headers.authorization) {
                return res.status(401).json({ error: 'Authentication needed!' });
            } else {
                let session = findSession(req.headers.authorization);

                if (!session) {
                    return res.status(403).json({ error: 'Invalid auth!' });
                }

                let sessionUser = await getUserData(session.name);

                if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
                    return res.status(403).json({ error: `Only admins and managers can view the details of upcoming jams!` });
                }
            }
        } else {
            let sessionUser = null;
            if (req.headers.authorization) {
                let session = findSession(req.headers.authorization);

                if (session) {
                    sessionUser = await getUserData(session.name);
                }
            }

            for (var i = 0; i < jamsList.length; i++) {
                if (new Date(jamsList?.[i]?.['dates']?.['start']) > new Date() && jamsList?.[i]?.['options']?.['enableMystery'] === true) {
                    jamsList[i]['mystery'] = true;

                    if (sessionUser ? !sessionUser.admin && !(await sessionUser.isManager(jamsList?.[i]?.['slug'])) : true) {
                        // This jam is scheduled to start in the future. Therefore, we hide all content that could allow users to get an unfair head start
                        delete jamsList[i]['content']['body'];
                        delete jamsList[i]['content']['colors'];
                        //delete jamsList[i]['content']['headerImage'];
                    }
                } else {
                    jamsList[i]['mystery'] = false;
                }
            }
        }
        res.status(200).json({ total: jamsCount, jams: jamsList });
    } else {
        // If we are looking for a specific jam
        let jam = await Jams.findOne({ slug: req.params.jam }).lean();

        if (jam) {
            // Loop through all jams and hide the title and main theme of jams that didn't start yet
            if (bypassMystery) {
                if (!req.headers.authorization) {
                    res.status(401).json({ error: 'Authentication needed!' });
                } else {
                    let session = findSession(req.headers.authorization);

                    if (!session) {
                        return res.status(403).json({ error: 'Invalid auth!' });
                    }

                    let sessionUser = await getUserData(session.name);

                    if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
                        return res.status(403).json({ error: `Only admins and managers can view the details of upcoming jams!` });
                    }
                }
            } else {
                let sessionUser = null;
                if (req.headers.authorization) {
                    let session = findSession(req.headers.authorization);

                    if (session) {
                        sessionUser = await getUserData(session.name);
                    }
                }

                if (new Date(jam['dates']['start']) > new Date() && jam?.['options']?.['enableMystery'] === true) {
                    jam['mystery'] = true;

                    if (sessionUser ? !sessionUser.admin && !(await sessionUser.isManager(jam['slug'])) : true) {
                        // This jam is scheduled to start in the future. Therefore, we hide all content that could allow users to get an unfair head start
                        delete jam['content']['body'];
                        delete jam['content']['colors'];
                        //delete jam['content']['headerImage'];
                    }
                } else {
                    jam['mystery'] = false;
                }
            }

            return res.status(200).json(jam);
        } else {
            return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
        }
    }
});

app.put('/api/jams/:jam?', cors(corsOptions), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'You need auth!' });
    } else {
        // Check whether the session is valid and the user has admin privileges
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);

        if (!req.params.jam) {
            // An admin is attempting to create a new jam
            if (!sessionUser.admin) {
                return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin!' } });
            }

            let record = req.body;
            let now = new Date();
            let meta = {
                meta: {
                    updated: now.toISOString(),
                    updatedBy: session.name,
                },
            };
            // Append the `meta` object to the record
            record = { ...record, ...meta };

            // Create the new jam using
            Jams.create(record)
                .then((createdDocument) => {
                    return res.status(200).json({ ok: 'The jam was successfully created!', slug: createdDocument.slug });
                })
                .catch((e) => {
                    console.log(e);
                    return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'One or more required parameters are missing from your query!' } });
                });
        } else {
            // An admin or a manager is attempting to update a specific jam.
            if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
                return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a manager!' } });
            }

            let now = new Date().toISOString();
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
                    body: req?.body?.content?.body,
                },
                options: {
                    enableMystery: req?.body?.options?.enableMystery,
                },
                meta: {
                    updated: now,
                    updatedBy: session.name,
                },
            };
            // Remove `undefined` and non-object values but keep `null`s, hence the `true` parameter
            updateQuery = cleanObject(updateQuery, true);

            // Retrieve the current jam and merge it with the cleaned, new jam
            let jam = await Jams.findOne({ slug: req.params.jam }).lean();
            if (!jam) {
                return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
            }
            if ((updateQuery?.dates?.end && new Date(updateQuery.dates.end).toISOString()) > now) {
                // If the jam is ongoing, clear any winners
                await Projects.updateMany({ jam: req.params.jam, $or: [{ selected: true }, { selectedByTheCommunity: true }] }, { selected: false, selectedByTheCommunity: false });
            }
            updateQuery = mergeObjects(jam, updateQuery);
            // Update the jam and return the new slug
            await Jams.findOneAndUpdate({ slug: req.params.jam }, { $set: updateQuery }, { new: true }).then((updatedDocument) => {
                if (updatedDocument) {
                    if (updatedDocument.slug != req.params.jam) {
                        // "Re-link" managers to the game jam if its slug was modified
                        Managers.updateMany({ jam: req.params.jam }, { $set: { jam: updatedDocument.slug } }).exec();
                    }
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
        return res.status(401).json({ error: 'You need auth!' });
    }

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    let sessionUser = await getUserData(session.name);

    if (!sessionUser.admin) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a game jam manager!' } });
    }

    // Delete jam and all submissions associated with it
    let jam = await Jams.findOne({ slug: req.params.jam });
    if (jam) {
        await Jams.deleteOne({ slug: req.params.jam });
        await Projects.deleteMany({ jam: req.params.jam });
        await Upvotes.deleteMany({ jam: req.params.jam });
        await Managers.deleteMany({ jam: req.params.jam });
    } else {
        return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
    }
    res.status(200).json({ ok: 'This jam has been successfully deleted!' });
});

app.options('/api/jams/:jam/managers/', cors(corsOptions));

app.get('/api/jams/:jam/managers', cors(corsOptions), async (req, res) => {
    let managers = await Managers.find({ jam: req.params.jam });

    return res.status(200).json({ managers: managers });
});

app.put('/api/jams/:jam/managers/', cors(corsOptions), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'You need auth!' });
    } else {
        // Check whether the session is valid and the user has admin privileges
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);

        if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
            return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a moderator!' } });
        }

        let record = req.body;
        record = { ...record, jam: req.params.jam };

        if (await Managers.exists({ jam: record.jam, name: record.name })) {
            return res.status(400).json({ error: { status: 409, code: 'recordAlreadyExists', detail: 'The requested user is already a manager in this jam!' } });
        }

        let user = await Users.exists({ name: record.name });

        if (!user) {
            return res.status(400).json({ error: { status: 400, code: 'userNotFound', detail: "This user doesn't exist in Itinerary's database!" } });
        }

        if ((await getUserData(record.name)).admin) {
            return res.status(400).json({ error: { status: 400, code: 'userIsAdmin', detail: 'This user is an administrator thus they already have access to manager tools on every jam!' } });
        }

        // Add the new manager
        Managers.create(record)
            .then(() => {
                return res.status(200).json({ ok: 'The manager was added to the jam!' });
            })
            .catch((e) => {
                console.log(e);
                return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'One or more required parameters are missing from your query!' } });
            });
    }
});

app.delete('/api/jams/:jam/managers/', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    let sessionUser = await getUserData(session.name);

    let record = req.body;
    record = { ...record, jam: req.params.jam };

    if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a manager!' } });
    }

    // Delete jam and all submissions associated with it
    let manager = await Managers.findOne({ jam: record.jam, name: record.name });
    if (manager) {
        await Managers.deleteOne({ jam: record.jam, name: record.name });
    } else {
        return res.status(404).json({ error: { status: 404, code: 'managerNotFound', detail: 'The requested manager could not be found.' } });
    }
    res.status(200).json({ ok: 'The manager has been removed from this jam!' });
});

app.options('/api/jams/:jam/user-data/', cors(corsOptions));

app.get('/api/jams/:jam/user-data', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'Authentication needed!' });
    } else {
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let sessionUser = await getUserData(session.name);
        let isManager = await sessionUser.isManager(req.params.jam);

        let hasParticipated;

        let count = await Projects.countDocuments({ jam: req.params.jam, 'meta.submittedBy': session.name });
        if (count > 0) {
            hasParticipated = true;
        } else {
            hasParticipated = false;
        }

        res.status(200).json({ ok: { hasParticipated, manager: isManager } });
    }
});

app.options('/api/jams/:jam/projects/:project?', cors(corsOptions));

app.get('/api/jams/:jam/projects/:project?', cors(), async (req, res) => {
    let jam = await Jams.findOne({ slug: req.params.jam }).lean();
    if (!jam) {
        return res.status(404).json({ error: { status: 404, code: 'jamNotFound', detail: 'The requested jam could not be found.' } });
    }

    await computeCommunitySelectedWinner(req.params.jam);

    if (!req.params.project) {
        // If we are NOT looking for a specific project
        const limit = req.query.limit;

        let projectsList = await Projects.find({ jam: req.params.jam }).sort({ 'meta.submitted': 'descending' }).lean().exec();

        if (!limit) {
            // Return all projects
            res.status(200).json(projectsList);
        } else {
            // Return a maximum of `limit` projects
            res.status(200).json(projectsList.slice(0, limit));
        }
    } else {
        // If we are looking for a specific project
        let project = await Projects.findOne({ project: req.params.project }).lean();
        if (!project) {
            return res.status(404).json({ error: { status: 404, code: 'projectNotFound', detail: 'The requested project could not be found.' } });
        }

        return res.status(200).json(project);
    }
});

app.put('/api/jams/:jam/projects/', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    // Prepare the record and verify whether the project exists
    let record = req.body;

    if (!record.project || !record.jam) {
        return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'You must provide both the `project` and `jam` parameters!' } });
    }

    let jam = await Jams.findOne({ slug: req.params.jam }).lean();
    if (!jam) return res.status(400).json({ error: { status: 400, code: 'jamNotFound', detail: "The jam you are trying to submit a project to doesn't exist!" } });
    let today = new Date().toISOString();

    if (!((jam.dates.start && new Date(jam.dates.start).toISOString()) <= today && today < (jam.dates.end && new Date(jam.dates.end).toISOString()))) {
        return res.status(403).json({ error: { status: 403, code: 'jamNotOpen', detail: 'This jam is not accepting submissions!' } });
    }

    let response = await fetch(`https://scratchdb.lefty.one/v3/project/info/${record.project}`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
        },
    });
    response = await response.json();

    // TODO: Distinguish between different types of errors
    if (response.error) {
        return res.status(400).json({ error: { status: 400, code: 'badRequest', detail: "This project probably doesn't exist!" } });
    }

    // Check whether the submitter is the owner of the project.
    if (response.username !== session.name) {
        return res.status(403).json({ error: { status: 403, code: 'illegalRequest', detail: 'You can only submit projects YOU own!' } });
    }

    // Check whether the project was already submitted
    let count = await Projects.countDocuments({ project: record.project, jam: record.jam });
    if (count > 0) {
        return res.status(403).json({ error: { status: 403, code: 'alreadySubmitted', detail: 'This project is already submitted!' } });
    }

    let now = new Date();
    let meta = {
        meta: {
            submitted: now.toISOString(),
            submittedBy: session.name,
        },
    };
    // Append the `meta` object to the record
    record = { ...record, ...meta };
    // Save the submission
    await Projects.create(record)
        .then(() => {
            return res.status(200).json({ ok: 'Your submission was recorded' });
        })
        .catch((e) => {
            console.log(e);
            return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'One or more required parameters are missing from your query!' } });
        });
});

app.delete('/api/jams/:jam/projects/:project', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    if (!req.params.project) {
        return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'No project specified to delete.' } });
    }

    let project = await Projects.findOne({ project: req.params.project }).lean();
    if (!project) {
        return res.status(404).json({ error: { status: 404, code: 'projectNotFound', detail: 'The requested project could not be found.' } });
    }

    let sessionUser = await getUserData(session.name);

    if (!sessionUser.admin && session.name !== project.meta.submittedBy && !(await sessionUser.isManager(req.params.jam))) {
        return res
            .status(403)
            .json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin, a manager, or the person who submitted the project!' } });
    }

    // Delete the project and all upvotes associated with it
    await Projects.deleteOne({ project: req.params.project, jam: req.params.jam });
    await Upvotes.deleteMany({ project: req.params.project, jam: req.params.jam });

    await computeCommunitySelectedWinner(req.params.jam);

    res.status(200).json({ ok: 'Your submission was removed!' });
});

app.options('/api/jams/:jam/upvotes/:project?', cors(corsOptions));

app.get('/api/jams/:jam/upvotes/:project?', cors(), async (req, res) => {
    if (!req.params.project) {
        // If we are searching for the upvotes cast by the account that sent the request in a specific jam

        // Verify that the `Authorization` header was sent with the request
        if (!req.headers.authorization) {
            return res.status(401).json({ error: 'You need auth!' });
        }

        // Check whether the session is valid
        let session = findSession(req.headers.authorization);

        if (!session) {
            return res.status(403).json({ error: 'Invalid auth!' });
        }

        let upvotes = await Upvotes.find({ jam: req.params.jam, 'meta.upvotedBy': session.name });
        let remainingUpvotes = MAX_UPVOTES_PER_JAM - upvotes.length;

        return res.status(200).json({ ok: true, upvotes: upvotes, remainingUpvotes: remainingUpvotes });
    } else {
        // If we are looking for the TOTAL number of upvotes a project received in a specific game jam
        let upvotes = await Upvotes.countDocuments({ jam: req.params.jam, project: req.params.project });
        let upvotedByUser = false;
        let extra = null;
        if (req.headers.authorization) {
            let session = findSession(req.headers.authorization);

            if (!session) {
                return res.status(403).json({ error: 'Invalid auth!' });
            }

            if ((await Upvotes.countDocuments({ jam: req.params.jam, project: req.params.project, 'meta.upvotedBy': session.name })) > 0) {
                upvotedByUser = true;
            }

            extra = { upvoted: upvotedByUser };
        }

        return res.status(200).json({ ok: true, count: upvotes, ...extra });
    }
});

app.put('/api/jams/:jam/upvotes/:project?', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    // Prepare the record
    let record = { jam: req.params.jam, project: req.params.project };

    if (!record.project || !record.jam) {
        return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'Your request is incomplete!' } });
    }

    // Check whether the user is within the upvote limit per game jam
    let upvotes = await Upvotes.countDocuments({ jam: req.params.jam, 'meta.upvotedBy': session.name });
    let remainingUpvotes = upvotes - MAX_UPVOTES_PER_JAM;

    if (remainingUpvotes === 0) {
        return res.status(403).json({
            error: {
                status: 403,
                code: 'tooManyUpvotes',
                detail: `You can only upvote ${MAX_UPVOTES_PER_JAM} ${
                    MAX_UPVOTES_PER_JAM == 1 ? 'project' : 'projects'
                } per game jam! This limit exists to encourage users to evaluate each project, possibly leave some constructive feedback, and carefully consider which projects they should upvote.`,
            },
        });
    }

    // Check whether the upvote was already cast
    let count = await Upvotes.countDocuments({ project: record.project, jam: record.jam, 'meta.upvotedBy': session.name });
    if (count > 0) {
        return res.status(403).json({ error: { status: 403, code: 'alreadySubmitted', detail: 'You have already cast a vote on this project!' } });
    }

    let now = new Date();
    let meta = {
        meta: {
            upvoted: now.toISOString(),
            upvotedBy: session.name,
        },
    };
    // Append the `meta` object to the record
    record = { ...record, ...meta };
    // Save the submission
    await Upvotes.create(record)
        .then(() => {
            return res.status(200).json({ ok: 'Your vote was saved' });
        })
        .catch((e) => {
            console.log(e);
            return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'One or more required parameters are missing from your query!' } });
        });
});

app.delete('/api/jams/:jam/upvotes/:project?', cors(), async (req, res) => {
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    if (!req.params.project) {
        await Upvotes.deleteMany({ jam: req.params.jam });
    }

    // Delete the project and all upvotes associated with it
    let { deletedCount } = await Upvotes.deleteOne({ project: req.params.project, jam: req.params.jam, 'meta.upvotedBy': session.name });

    if (deletedCount > 0) {
        res.status(200).json({ ok: 'Your upvote was removed!' });
    } else {
        return res.status(404).json({ error: { status: 404, code: 'upvoteNeverCast', detail: 'No upvotes were cast for this project during this jam.' } });
    }
});

app.options('/api/jams/:jam/winners/', cors(corsOptions));

app.get('/api/jams/:jam/winners/', cors(), async (req, res) => {
    await computeCommunitySelectedWinner(req.params.jam);
    let winners = await Projects.find({ jam: req.params.jam, $or: [{ selected: true }, { selectedByTheCommunity: true }] });

    return res.status(200).json({ winners: winners });
});

app.put('/api/jams/:jam/winners/', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    // Prepare the record and verify whether the project exists
    let record = req.body;

    if (!record.project) {
        return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'You must provide the `project` parameter!' } });
    }

    let sessionUser = await getUserData(session.name);
    if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a manager!' } });
    }

    await Projects.updateMany({ jam: req.params.jam, project: { $ne: record.project } }, { selected: false });
    await Projects.updateOne({ jam: req.params.jam, project: record.project }, { selected: true, selectedByTheCommunity: false });

    await computeCommunitySelectedWinner(req.params.jam);

    return res.status(200).json({ ok: 'The requested project was selected as the winner.' });
});

app.delete('/api/jams/:jam/winners/', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    // Prepare the record and verify whether the project exists
    let record = req.body;

    if (!record.project) {
        return res.status(400).json({ error: { status: 400, code: 'missingParameters', detail: 'You must provide the `project` parameter!' } });
    }

    let sessionUser = await getUserData(session.name);
    if (!sessionUser.admin && !(await sessionUser.isManager(req.params.jam))) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin or a manager!' } });
    }

    await Projects.updateOne({ jam: req.params.jam, project: record.project }, { selected: false });

    await computeCommunitySelectedWinner(req.params.jam);

    return res.status(200).json({ ok: 'The requested project was stripped of the winner status.' });
});

app.options('/api/jams/:jam/feature/', cors(corsOptions));

app.put('/api/jams/:jam/feature/', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    let sessionUser = await getUserData(session.name);
    if (!sessionUser.admin) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin!' } });
    }

    await Jams.updateOne({ slug: req.params.jam }, { featured: true });

    return res.status(200).json({ ok: 'The requested jam was featured.' });
});

app.delete('/api/jams/:jam/feature/', cors(), async (req, res) => {
    // Verify that the `Authorization` header was sent with the request
    if (!req.headers.authorization) {
        return res.status(401).json({ error: 'You need auth!' });
    }

    // Check whether the session is valid
    let session = findSession(req.headers.authorization);

    if (!session) {
        return res.status(403).json({ error: 'Invalid auth!' });
    }

    let sessionUser = await getUserData(session.name);
    if (!sessionUser.admin) {
        return res.status(403).json({ error: { status: 403, code: 'insufficientPermissions', detail: 'This action can only be performed by an admin!' } });
    }

    await Jams.updateOne({ slug: req.params.jam }, { featured: false });

    return res.status(200).json({ ok: 'The requested jam was unfeatured.' });
});

async function computeCommunitySelectedWinner(jam) {
    /*
    This function finds the most upvoted project in the provided game jam
    and marks it as the community selected winner. If multiple projects have
    the same number of votes, the system will select the oldest based on
    the date of submission.
    */

    let jamEnd = await Jams.findOne({ slug: jam });
    if (!jamEnd) return;
    jamEnd = jamEnd.dates.end;

    // If the jam is still ongoing, don't compute the community winner yet
    let today = new Date().toISOString();
    if (new Date(jamEnd).toISOString() > today) return;

    let projects = await Projects.find({ jam: jam, selected: { $ne: true } });
    let upvotes = await Upvotes.find({ jam: jam });

    if (projects.length < 1) return;

    // Filter out upvotes that were cast for a project that was selected as the winner
    upvotes = upvotes.filter(({ project }) => projects.some((e) => e.project === project));
    if (upvotes.length < 1) {
        await Projects.updateMany({ jam: jam, selectedByTheCommunity: true }, { selectedByTheCommunity: false });
        return;
    }

    const getDateByProject = (id) => {
        for (const key in projects) {
            if (projects[key].project == id) {
                return projects[key].meta.submitted;
            }
        }
    };

    let tally = {};

    for (const key in upvotes) {
        if (tally[upvotes[key].project]) {
            tally[upvotes[key].project].count += 1;
        } else {
            tally[upvotes[key].project] = { project: upvotes[key].project, count: 1, date: getDateByProject(upvotes[key].project) };
        }
    }

    let winner = Object.values(tally).reduce((tempWinner, currentTally) => {
        if (!tempWinner) {
            tempWinner = currentTally;
        }

        if (tempWinner.count < currentTally.count) {
            return currentTally;
        } else if (tempWinner.count === currentTally.count) {
            if (new Date(tempWinner.date).toISOString() > new Date(currentTally.date).toISOString()) {
                return currentTally;
            } else {
                return tempWinner;
            }
        } else {
            return tempWinner;
        }
    });

    await Projects.updateMany({ jam: jam, project: { $ne: winner.project } }, { selectedByTheCommunity: false });
    await Projects.updateOne({ jam: jam, project: winner.project }, { selectedByTheCommunity: true });
}

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
    }
    redirect = Buffer.from(redirect).toString('base64');
    res.redirect(`https://auth.itinerary.eu.org/auth/?redirect=${redirect}&name=Itinerary`);
});

app.get('/auth/handle', async (req, res) => {
    // The user is back from Hampton's authentication service
    const private = req.query.privateCode;

    let authResponse = await fetch('https://auth.itinerary.eu.org/api/auth/verifyToken?privateCode=' + private).catch((e) => {
        console.log(e);
        return res.redirect(`${frontendURL}/login?error=${1}`);
    });

    let authData = await authResponse.json();

    if (authData.valid) {
        // Get the proper case of the username instead of URL case

        let scratchResponse = await fetch(`https://api.scratch.mit.edu/users/${authData.username}/`).catch((e) => {
            console.log(e);
            return res.redirect(`${frontendURL}/login?error=${1}`);
        });
        let scratchData = await scratchResponse.json();

        if (!scratchData.username) {
            return res.status(404).json({ error: { status: 404, code: 'userNotFound', detail: 'This user could not be found on Scratch.' } });
        }

        let foundUser = await getUserData(scratchData.username);

        if (!foundUser) {
            let now = new Date();
            foundUser = await Users.create({
                name: scratchData.username,
                meta: {
                    updated: now.toISOString(),
                    updatedBy: null,
                },
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
            res.status(200).json({ name: session.name, token: session.token });
            await Sessions.updateOne({ oneTimeToken: req.query.token }, { $set: { oneTimeToken: null } });
            session.oneTimeToken = null;
        } else {
            res.status(404).json({ error: 'No session found! Invalid or expired one time token.' });
        }
    } else {
        res.status(400).json({ error: 'Requires query parameter token' });
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
            res.status(200).json({ ok: `Removed session for ${name}` });
        } else {
            res.status(400).json({ error: 'The session from the token is already invalid/expired!' });
        }
    } else {
        res.status(400).json({ error: 'Requires query parameter token' });
    }
});

app.options('/auth/me', cors(corsOptions));

app.get('/auth/me', cors(corsOptions), async (req, res) => {
    if (!req.headers.authorization) {
        res.status(401).json({ error: 'you need auth' });
    } else {
        let session = findSession(req.headers.authorization);
        if (!session) {
            return res.status(403).json({ error: { status: 403, code: 'invalidAuth', detail: 'Invalid auth!' } });
        }
        let user = await getUserData(session.name);
        if (user.banned) {
            res.status(403).json({ error: { status: 403, code: 'banned', detail: 'You are banned from Itinerary!', name: user.name } });
        }
        user ? res.status(200).json(user) : res.status(404).json({ error: "no user found.. this shouldn't happen" });
    }
});
/* --------------- */

// Handle 404 errors
app.all('*', (req, res) => {
    res.status(404).json({ error: { status: 404, code: 'notFound', detail: 'The requested resource could not be found on this path.' } });
});

/*
 * Utility functions
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

function getUserData(name) {
    var regexName = '^' + escapeRegExp(name) + '$';
    return new Promise(async (resolve, reject) => {
        try {
            var user = await Users.findOne({
                name: { $regex: new RegExp(regexName, 'i') },
            });
            if (user) {
                user.isManager = async (jam) => {
                    if ((await Managers.countDocuments({ jam: jam, name: user?.name })) > 0) {
                        return true;
                    } else {
                        return false;
                    }
                };
            }
            resolve(user);
        } catch (error) {
            reject(Error(error));
        }
    });
}

// Modified version of https://stackoverflow.com/a/52368116/14226941
function cleanObject(object, keepNull = false) {
    Object.entries(object).forEach(([k, v]) => {
        if (v && typeof v === 'object') {
            cleanObject(v, keepNull);
        }
        if (keepNull) {
            if ((v && typeof v === 'object' && !Object.keys(v).length) || v === null || v === undefined) {
                if (Array.isArray(object)) {
                    object.splice(k, 1);
                } else {
                    delete object[k];
                }
            }
        } else {
            if ((v && typeof v === 'object' && !Object.keys(v).length) || v === undefined) {
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
                reject('Failed to generate token.');
            }
            resolve(buffer);
        });
    });
    const token = crypto.createHash('sha1').update(buffer).digest('hex');

    return token;
}

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
    sessions = sessions.filter((obj) => {
        return obj.token !== token;
    });
    await Sessions.deleteOne({ token });
}

function findSession(token) {
    const session = sessions.find((f) => f.token == token);
    return session;
}

function findSessionByOneTimeToken(oneTimeToken) {
    const session = sessions.find((f) => f.oneTimeToken == oneTimeToken);
    return session;
}
/* --------------- */

app.listen(port, () => {
    console.log(`Listening on port ${port}...`);
});
