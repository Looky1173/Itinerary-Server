const mongoose = require('mongoose');

const UpvotesSchema = new mongoose.Schema(
    {
        jam: { type: String, required: true },
        project: { type: Number, required: true },
        meta: {
            upvoted: { type: Date, required: false },
            upvotedBy: { type: String, required: true },
        },
    },
    { collection: 'upvotes', versionKey: false },
);

const model = mongoose.model('UpvotesModel', UpvotesSchema);

module.exports = model;
