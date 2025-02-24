"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prettifyUnixTs = prettifyUnixTs;
const date_fns_1 = require("date-fns");
function prettifyUnixTs(d) {
    const date = new Date(d);
    return (0, date_fns_1.formatDate)(date, 'MM/dd/yyyy HH:mm:ss');
}
