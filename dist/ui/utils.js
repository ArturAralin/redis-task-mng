"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prettifyUnixTs = prettifyUnixTs;
const date_fns_1 = require("date-fns");
function prettifyUnixTs(d) {
    const date = (0, date_fns_1.formatDate)(d, 'dd/MM/yyyy HH:mm:ss');
    return `${date} UTC`;
}
