const mongoose = require('mongoose');
const slug = require('mongoose-slug-updater');

mongoose.plugin(slug);

const JamsSchema = new mongoose.Schema({
    name: { type: String, required: true },
    slug: { type: String, slug: 'name', unique: true },
    dates: {
        start: { type: Date, required: false },
        end: { type: Date, required: false },
        votingStart: { type: Date, required: false },
        votingEnd: { type: Date, required: false }
    },
    content: {
        headerImage: { type: String, required: false },
        colors: [{
            color: String,
            function: String
        }],
        description: { type: String, required: false },
        body: { type: String, required: true }
    },
    options: {
        showSubmissionsBeforeVoting: { type: Boolean, default: false }
    },
    meta: {
        updated: { type: Date, required: false },
        updatedBy: { type: String, required: false }
    }
}, { collection: 'jams', versionKey: false });

const model = mongoose.model('JamsModel', JamsSchema);

module.exports = model;