iD.Connection = function() {

    var event = d3.dispatch('auth', 'load'),
        url = 'http://www.openstreetmap.org',
        connection = {},
        refNodes = {},
        user = {},
        inflight = [],
        loadedTiles = {},
        oauth = iD.OAuth();

    function bboxUrl(b) {
        return url + '/api/0.6/map?bbox=' + [b[0][0],b[1][1],b[1][0],b[0][1]];
    }

    function bboxFromAPI(box, callback) {
         loadFromURL(bboxUrl(box), function(err, parsed) {
             loadedTiles[box] = true;
             callback(err, parsed);
         });
    }

    function loadFromURL(url, callback) {
        inflight.push(d3.xml(url).get()
            .on('load', function(dom) {
                return callback(null, parse(dom));
            }));
    }

    function getNodes(obj) {
        var nelems = obj.getElementsByTagName('nd'), nodes = new Array(nelems.length);
        for (var i = 0, l = nelems.length; i < l; i++) {
            nodes[i] = 'n' + nelems[i].attributes.ref.nodeValue;
            refNodes['n' + nelems[i].attributes.ref.nodeValue] = true;
        }
        return nodes;
    }

    function getTags(obj) {
        var tags = {}, tagelems = obj.getElementsByTagName('tag');
        for (var i = 0, l = tagelems.length; i < l; i++) {
            var item = tagelems[i];
            tags[item.attributes.k.nodeValue] = item.attributes.v.nodeValue;
        }
        return tags;
    }

    function getMembers(obj) {
        var elems = obj.getElementsByTagName('member'),
            members = new Array(elems.length);

        for (var i = 0, l = elems.length; i < l; i++) {
            members[i] = {
                id: elems[i].attributes.type.nodeValue[0] + elems[i].attributes.ref.nodeValue,
                type: elems[i].attributes.type.nodeValue,
                role: elems[i].attributes.role.nodeValue
            };
        }
        return members;
    }

    function objectData(obj) {
        var o = {
            type: obj.nodeName,
            members: getMembers(obj),
            nodes: getNodes(obj),
            tags: getTags(obj)
        };
        for (var i = 0, l = obj.attributes.length; i < l; i++) {
            var n = obj.attributes[i].nodeName;
            var v = obj.attributes[i].nodeValue;
            o[n] = v;
        }
        if (o.lon && o.lat) {
            o.loc = [parseFloat(o.lon), parseFloat(o.lat)];
            delete o.lon;
            delete o.lat;
        }
        o.id = iD.Entity.id.fromOSM(o.type, o.id);
        if (o.type === 'node') o._poi = !refNodes[o.id];
        return iD.Entity(o);
    }

    function parse(dom) {
        if (!dom || !dom.childNodes) return new Error('Bad request');
        var root = dom.childNodes[0];
        var entities = {};
        refNodes = {};

        function addEntity(obj) {
            var o = objectData(obj);
            entities[o.id] = o;
        }

        _.forEach(root.getElementsByTagName('way'), addEntity);
        _.forEach(root.getElementsByTagName('node'), addEntity);
        _.forEach(root.getElementsByTagName('relation'), addEntity);

        return iD.Graph(entities);
    }

    function authenticated() {
        return oauth.authenticated();
    }

    connection.putChangeset = function(changes, comment, callback) {
        oauth.xhr({
                method: 'PUT',
                path: '/api/0.6/changeset/create',
                options: { header: { 'Content-Type': 'text/xml' } },
                content: iD.format.XML.changeset(comment)
            }, function (err, changeset_id) {
                if (err) return callback(err);
                oauth.xhr({
                    method: 'POST',
                    path: '/api/0.6/changeset/' + changeset_id + '/upload',
                    options: { header: { 'Content-Type': 'text/xml' } },
                    content: iD.format.XML.osmChange(user.id, changeset_id, changes)
                }, function (err) {
                    if (err) return callback(err);
                    oauth.xhr({
                        method: 'PUT',
                        path: '/api/0.6/changeset/' + changeset_id + '/close'
                    }, function (err) {
                        callback(err, changeset_id);
                    });
                });
            });
    };

    function userDetails(callback) {
        oauth.xhr({ method: 'GET', path: '/api/0.6/user/details' }, function(err, user_details) {
            var u = user_details.getElementsByTagName('user')[0];
            callback(connection.user({
                display_name: u.attributes.display_name.nodeValue,
                id: u.attributes.id.nodeValue
            }).user());
        });
    }

    connection.userUrl = function(username) {
        return url + "/user/" + username;
    };

    function tileAtZoom(t, distance) {
        var power = Math.pow(2, distance);
        return [
            Math.floor(t[0] * power),
            Math.floor(t[1] * power),
            t[2] + distance];
    }

    function tileAlreadyLoaded(c) {
        if (loadedTiles[c]) return false;
        for (var i = 0; i < 4; i++) {
            if (loadedTiles[tileAtZoom(c, -i)]) return false;
        }
        return true;
    }

    function loadTiles(projection) {
        var scaleExtent = [16, 16],
            s = projection.scale(),
            tiles = d3.geo.tile()
                .scaleExtent(scaleExtent)
                .scale(s)
                .translate(projection.translate())(),
            z = Math.max(Math.log(s) / Math.log(2) - 8, 0),
            rz = Math.max(scaleExtent[0], Math.min(scaleExtent[1], Math.floor(z))),
            ts = 256 * Math.pow(2, z - rz),
            tile_origin = [
                s / 2 - projection.translate()[0],
                s / 2 - projection.translate()[1]];

        function apiExtentBox(c) {
            var x = (c[0] * ts) - tile_origin[0];
            var y = (c[1] * ts) - tile_origin[1];
            return [
                projection.invert([x, y]),
                projection.invert([x + ts, y + ts])];
        }

        inflight.map(function(i) {
            i.abort();
        });
        inflight = [];

        tiles
            .map(apiExtentBox)
            .filter(tileAlreadyLoaded)
            .forEach(function(e) {
                bboxFromAPI(e, function(err, g) {
                    event.load(err, g);
                });
            });
    }

    connection.url = function(_) {
        if (!arguments.length) return url;
        url = _;
        oauth.url(_);
        return connection;
    };

    connection.user = function(_) {
        if (!arguments.length) return user;
        user = _;
        return connection;
    };

    connection.flush = function() {
        loadedTiles = {};
        return connection;
    };

    connection.logout = function() {
        oauth.logout();
        event.auth();
        return connection;
    };

    connection.authenticate = function(callback) {
        return oauth.authenticate(function(err, res) {
            event.auth();
            if (callback) callback(err, res);
        });
    };

    connection.bboxFromAPI = bboxFromAPI;
    connection.loadFromURL = loadFromURL;
    connection.loadTiles = _.debounce(loadTiles, 100);
    connection.userDetails = userDetails;
    connection.authenticated = authenticated;
    connection.objectData = objectData;

    return d3.rebind(connection, event, 'on');
};
