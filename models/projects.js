const mongoose = require('mongoose');

const ProjectsSchema = new mongoose.Schema(
    {
        jam: { type: String, required: true },
        project: { type: Number, required: true },
        meta: {
            submitted: { type: Date, required: false },
            submittedBy: { type: String, required: true },
        },
        selected: { type: Boolean, required: false },
        selectedByTheCommunity: { type: Boolean, required: false },
    },
    { collection: 'projects', versionKey: false },
);

const model = mongoose.model('ProjectsModel', ProjectsSchema);

module.exports = model;
