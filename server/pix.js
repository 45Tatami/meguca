var async = require('async'),
    common = require('../common'),
    config = require('../config'),
    child_process = require('child_process'),
    db = require('../db'),
    formidable = require('formidable'),
    fs = require('fs'),
    hooks = require('../hooks'),
    im = require('imagemagick'),
    path = require('path'),
    util = require('util'),
    winston = require('winston');

var image_attrs = ('src thumb dims size MD5 hash imgnm spoiler realthumb vint'
		+ ' apng').split(' ');

function is_image(image) {
	return image && (image.src || image.vint);
};

hooks.hook('extractPost', function (post, cb) {
	if (!is_image(post))
		return cb(null);
	var image = {};
	image_attrs.forEach(function (key) {
		if (key in post) {
			image[key] = post[key];
			delete post[key];
		}
	});
	if (image.dims.split)
		image.dims = image.dims.split(',');
	image.size = parseInt(image.size);
	delete image.hash;
	post.image = image;
	cb(null);
});

hooks.hook('inlinePost', function (info, cb) {
	var post = info.dest, image = info.src.image;
	if (!image)
		return cb(null);
	image_attrs.forEach(function (key) {
		if (key in image)
			post[key] = image[key];
	});
	cb(null);
});

function get_thumb_specs(w, h, pinky) {
	var QUALITY = config[pinky ? 'PINKY_QUALITY' : 'THUMB_QUALITY'];
	var bound = config[pinky ? 'PINKY_DIMENSIONS' : 'THUMB_DIMENSIONS'];
	var r = Math.max(w / bound[0], h / bound[1], 1);
	var bg = pinky ? '#d6daf0' : '#eef2ff';
	return {dims: [Math.round(w/r), Math.round(h/r)], quality: QUALITY,
			bg_color: bg, bound: bound};
}

exports.ImageUpload = function (db, status) {
	this.db = db;
	this.statusCallback = status;
};

var IU = exports.ImageUpload.prototype;

var validFields = ['client_id', 'spoiler', 'op'];

IU.status = function (msg) {
	this.form_call('upload_status', msg);
};

IU.handle_request = function (req, resp, board) {
	this.board = board;
	this.resp = resp;
	var len = parseInt(req.headers['content-length'], 10);
	if (len > 0 && len > config.IMAGE_FILESIZE_MAX + (20*1024))
		return this.failure('File is too large.');

	var form = new formidable.IncomingForm();
	form.uploadDir = config.MEDIA_DIRS.tmp;
	form.maxFieldsSize = 50 * 1024;
	form.hash = 'md5';
	form.onPart = function (part) {
		if (part.filename && part.name == 'image')
			form.handlePart(part);
		else if (!part.filename && validFields.indexOf(part.name) >= 0)
			form.handlePart(part);
	};
	var self = this;
	form.once('error', function (err) {
		winston.error('formidable: ' + err);
		self.failure('Upload request problem.');
	});
	form.once('aborted', function (err) {
		self.failure('Upload was aborted.');
	});
	this.lastProgress = -1;
	form.on('field', function (key, value) {
		if (key == 'client_id')
			self.client_id = value;
	});
	form.on('progress', this.upload_progress_status.bind(this));

	try {
		form.parse(req, this.parse_form.bind(this));
	}
	catch (err) {
		winston.error('caught: ' + err);
		if (typeof err != 'string')
			err = 'Invalid request.';
		self.failure(err);
	}
};

IU.upload_progress_status = function (received, total) {
	var percent = Math.floor(100 * received / total);
	var increment = (total > (512 * 1024)) ? 25 : 10;
	var quantized = Math.floor(percent / increment) * increment;
	if (quantized > this.lastProgress) {
		this.status(percent + '% received...');
		this.lastProgress = quantized;
	}
};

IU.parse_form = function (err, fields, files) {
	if (err) {
		winston.error("Upload error: " + err);
		return this.failure('Invalid upload.');
	}
	if (!files.image)
		return this.failure('No image.');
	this.image = files.image;
	this.client_id = fields.client_id;
	this.pinky = !!parseInt(fields.op, 10);

	var spoiler = parseInt(fields.spoiler, 10);
	if (spoiler) {
		var sps = config.SPOILER_IMAGES;
		if (sps.normal.indexOf(spoiler) < 0
				&& sps.trans.indexOf(spoiler) < 0)
			return this.failure('Bad spoiler.');
		this.image.spoiler = spoiler;
	}

	this.image.MD5 = squish_MD5(this.image.hash);
	this.image.hash = null;

	this.db.track_temporaries([this.image.path], null,
			this.process.bind(this));
};

IU.process = function (err) {
	if (err)
		winston.warn("Temp tracking error: " + err);
	if (this.failed)
		return;
	var image = this.image;
	image.ext = path.extname(image.filename).toLowerCase();
	if (image.ext == '.jpeg')
		image.ext = '.jpg';
	if (['.png', '.jpg', '.gif'].indexOf(image.ext) < 0)
		return this.failure('Invalid image format.');
	image.imgnm = image.filename.substr(0, 256);

	this.status('Verifying...');
	var tagged_path = image.ext.replace('.', '') + ':' + image.path;
	var self = this;
	var checks = {
		stat: fs.stat.bind(fs, image.path),
		dims: im.identify.bind(im, tagged_path),
	};
	if (image.ext == '.png')
		checks.apng = detect_APNG.bind(null, image.path);
	async.parallel(checks, verified);

	function verified(err, rs) {
		if (err) {
			winston.error(err);
			return self.failure('Bad image.');
		}
		var w = rs.dims.width, h = rs.dims.height;
		image.size = rs.stat.size;
		image.dims = [w, h];
		if (!w || !h)
			return self.failure('Invalid image dimensions.');
		if (w > config.IMAGE_WIDTH_MAX)
			return self.failure('Image is too wide.');
		if (h > config.IMAGE_HEIGHT_MAX)
			return self.failure('Image is too tall.');
		if (rs.apng)
			image.apng = 1;

		perceptual_hash(tagged_path, function (err, hash) {
			if (err)
				return self.failure(err);
			image.hash = rs.hash;
			self.db.check_duplicate(image.hash, deduped);
		});
	}

	function deduped(err, rs) {
		if (err)
			return self.failure(err);
		image.thumb_path = image.path + '_thumb';
		var pinky = self.pinky;
		var w = image.dims[0], h = image.dims[1];
		var specs = get_thumb_specs(w, h, pinky);
		/* Determine if we really need a thumbnail */
		var sp = image.spoiler;
		if (!sp && image.size < 30*1024
				&& ['.jpg', '.png'].indexOf(image.ext) >= 0
				&& !image.apng
				&& w <= specs.dims[0] && h <= specs.dims[1]) {
			return got_thumbnail(false, false, null);
		}
		var info = {
			src: tagged_path,
			ext: image.ext,
			dest: image.thumb_path,
			dims: specs.dims,
			quality: specs.quality,
			bg: specs.bg_color,
		};
		if (sp && config.SPOILER_IMAGES.trans.indexOf(sp) >= 0) {
			self.status('Spoilering...');
			var comp = composite_src(sp, pinky);
			image.comp_path = image.path + '_comp';
			image.dims = [w, h].concat(specs.bound);
			info.composite = comp;
			info.compDest = image.comp_path;
			info.compDims = specs.bound;
			async.parallel([resize_image.bind(null, info, false),
				resize_image.bind(null, info, true)],
				got_thumbnail.bind(null, true, comp));
		}
		else {
			image.dims = [w, h].concat(specs.dims);
			if (!sp)
				self.status('Thumbnailing...');
			resize_image(info, false,
					got_thumbnail.bind(null, true, false));
		}
	}

	function got_thumbnail(nail, comp, err) {
		if (err)
			return self.failure(err);
		self.status('Publishing...');
		var time = new Date().getTime();
		image.src = time + image.ext;
		var dest, mvs;
		dest = media_path('src', image.src);
		mvs = [mv_file.bind(null, image.path, dest)];
		if (nail) {
			nail = time + '.jpg';
			image.thumb = nail;
			nail = media_path('thumb', nail);
			mvs.push(mv_file.bind(null, image.thumb_path, nail));
		}
		if (comp) {
			comp = time + 's' + image.spoiler + '.jpg';
			image.composite = comp;
			comp = media_path('thumb', comp);
			mvs.push(mv_file.bind(null, image.comp_path, comp));
			delete image.spoiler;
		}
		async.parallel(mvs, function (err, rs) {
			if (err) {
				winston.error(err);
				return self.failure("Distro failure.");
			}
			var olds = [image.path];
			var news = [dest];
			image.path = dest;
			if (nail) {
				image.thumb_path = nail;
				news.push(nail);
			}
			if (comp) {
				image.comp_path = comp;
				news.push(comp);
			}
			self.db.track_temporaries(news, olds,
					self.record_image.bind(self));
		});
	}
}

function composite_src(spoiler, pinky) {
	var file = 'spoiler' + (pinky ? 's' : '') + spoiler + '.png';
	return path.join('www', 'kana', file);
}

function media_path(dir, filename) {
	return path.join(config.MEDIA_DIRS[dir], filename);
}
exports.media_path = media_path;

function dead_path(dir, filename) {
	return path.join(config.MEDIA_DIRS.dead, dir, filename);
}

IU.read_image_filesize = function (callback) {
	var self = this;
	fs.stat(this.image.path, function (err, stat) {
		if (err) {
			winston.error(err);
			callback('Internal filesize error.');
		}
		else if (stat.size > config.IMAGE_FILESIZE_MAX)
			callback('File is too large.');
		else
			callback(null, stat.size);
	});
};

function squish_MD5(hash) {
	if (typeof hash == 'string')
		hash = new Buffer(hash, 'hex');
	return hash.toString('base64').replace(/\//g, '_').replace(/=*$/, '');
}
exports.squish_MD5 = squish_MD5;

function mv_file(src, dest, callback) {
	child_process.execFile('/bin/mv', ['-n', src, dest],
				function (err, stdout, stderr) {
		if (err) {
			winston.error(stderr);
			return callback(err);
		}
		callback(null);
	});
}
exports.mv_file = mv_file;

function perceptual_hash(src, callback) {
	var tmp = '/tmp/hash' + common.random_id() + '.gray';
	var args = [src + '[0]',
			'-background', 'white', '-mosaic', '+matte',
			'-scale', '16x16!',
			'-type', 'grayscale', '-depth', '8',
			tmp];
	im.convert(args, function (err, stdout, stderr) {
		if (err) {
			winston.error(stderr);
			return callback('Hashing error.');
		}
		var bin = path.join(__dirname, 'perceptual');
		child_process.execFile(bin, [tmp],
					function (err, stdout, stderr) {
			fs.unlink(tmp);
			if (err) {
				winston.error(stderr);
				return callback('Hashing error.');
			}
			var hash = stdout.trim();
			if (hash.length != 64)
				return callback('Hashing problem.');
			callback(null, hash);
		});
	});
}

function detect_APNG(fnm, callback) {
	var bin = path.join(__dirname, 'findapng');
	child_process.execFile(bin, [fnm], function (err, stdout, stderr) {
		if (err)
			return callback(stderr);
		else if (stdout.match(/^APNG/))
			return callback(null, true);
		else if (stdout.match(/^PNG/))
			return callback(null, false);
		else
			return callback(stderr);
	});
}

hooks.hook("buryImage", function (info, callback) {
	if (!info.src)
		return callback(null);
	/* Just in case */
	var m = /^\d+\w*\.\w+$/;
	if (!info.src.match(m))
		return callback('Invalid image.');
	var mvs = [mv.bind(null, 'src', info.src)];
	function try_thumb(t) {
		if (!t)
			return;
		if (!t.match(m))
			return callback('Invalid thumbnail.');
		mvs.push(mv.bind(null, 'thumb', t));
	}
	try_thumb(info.thumb);
	try_thumb(info.realthumb);
	async.parallel(mvs, callback);
	function mv(p, nm, cb) {
		mv_file(media_path(p, nm), dead_path(p, nm), cb);
	}
});

function setup_im_args(o, args) {
	var args = [], dims = o.dims;
	if (o.ext == '.jpg')
		args.push('-define', 'jpeg:size=' + (dims[0] * 2) + 'x' +
				(dims[1] * 2));
	if (!o.setup) {
		o.src += '[0]';
		o.dest = 'jpg:' + o.dest;
		if (o.compDest)
			o.compDest = 'jpg:' + o.compDest;
		o.flatDims = o.dims[0] + 'x' + o.dims[1];
		if (o.compDims)
			o.compDims = o.compDims[0] + 'x' + o.compDims[1];
		o.quality += '';
		o.setup = true;
	}
	args.push(o.src, '-gamma', '0.454545', '-filter', 'box');
	return args;
}

function resize_image(o, comp, callback) {
	var args = setup_im_args(o);
	var dims = comp ? o.compDims : o.flatDims;
	args.push('-resize', dims + (comp ? '^' : '!'));
	args.push('-gamma', '2.2', '-background', o.bg);
	if (comp)
		args.push(o.composite, '-layers', 'flatten', '-extent', dims);
	else
		args.push('-layers', 'mosaic', '+matte');
	args.push('-strip', '-quality', o.quality, comp ? o.compDest : o.dest);
	im.convert(args, im_callback.bind(null, callback));
}

function im_callback(cb, err, stdout, stderr) {
	if (err) {
		winston.error(stderr);
		return cb('Conversion error.');
	}
	if (config.DEBUG)
		setTimeout(cb, 1000);
	else
		cb();
}

function image_files(image) {
	var files = [];
	if (image.path)
		files.push(image.path);
	if (image.thumb_path)
		files.push(image.thumb_path);
	if (image.comp_path)
		files.push(image.comp_path);
	return files;
}

IU.failure = function (err_desc) {
	if (this.resp) {
		this.resp.writeHead(500, {'Content-Type': 'text/plain'});
		this.resp.end(err_desc);
		this.resp = null;
	}
	if (!this.failed) {
		this.form_call('upload_error', err_desc);
		this.failed = true;
	}
	if (this.image) {
		var files = image_files(this.image);
		files.forEach(function (file) {
			fs.unlink(file, function (err) {
				if (err)
					winston.warn("Deleting " +
						file + ": " + err);
			});
		});
		this.db.track_temporaries(null, files, function (err) {
			if (err)
				winston.warn("Tracking failure: " + err);
		});
	}
	this.db.disconnect();
};

IU.record_image = function (err) {
	if (err)
		winston.warn("Tracking failure: " + err);
	var view = {};
	var self = this;
	image_attrs.forEach(function (key) {
		if (key in self.image)
			view[key] = self.image[key];
	});
	if (this.image.composite) {
		view.realthumb = view.thumb;
		view.thumb = this.image.composite;
	}
	view.pinky = this.pinky;
	var image_id = common.random_id().toFixed();
	var alloc = {image: view, paths: image_files(this.image)};
	this.db.record_image_alloc(image_id, alloc, function (err) {
		if (err)
			return this.failure("Publishing failure.");
		self.form_call('on_image_alloc', image_id);
		self.db.disconnect();
		if (self.resp) {
			self.resp.writeHead(202);
			self.resp.end('OK');
			self.resp = null;
		}
	});
};

IU.form_call = function (func, param) {
	if (this.client_id) {
		var msg = {func: func, arg: param};
		this.statusCallback.call(null, this.client_id, msg);
	}
};

exports.send_dead_image = function (kind, filename, resp) {
	filename = dead_path(kind, filename);
	var stream = fs.createReadStream(filename);
	stream.once('error', function (err) {
		if (err.code == 'ENOENT') {
			console.log(filename);
			resp.writeHead(404);
			resp.end('Image not found');
		}
		else {
			winston.error(err);
			resp.end();
		}
	});
	stream.once('open', function () {
		var h = {};
		try {
			h['Content-Type'] = require('mime').lookup(filename);
		} catch (e) {}
		resp.writeHead(200, h);
		stream.pipe(resp);
	});
};
