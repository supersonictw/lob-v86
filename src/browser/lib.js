"use strict";

/** @const */
var ASYNC_SAFE = false;

(function()
{
    if(typeof XMLHttpRequest === "undefined")
    {
        v86util.load_file = load_file_nodejs;
    }
    else
    {
        v86util.load_file = load_file;
    }

    v86util.AsyncXHRBuffer = AsyncXHRBuffer;
    v86util.AsyncXHRPartfileBuffer = AsyncXHRPartfileBuffer;
    v86util.AsyncFileBuffer = AsyncFileBuffer;
    v86util.SyncFileBuffer = SyncFileBuffer;

    // Reads len characters at offset from Memory object mem as a JS string
    v86util.read_sized_string_from_mem = function read_sized_string_from_mem(mem, offset, len)
    {
        offset >>>= 0;
        len >>>= 0;
        return String.fromCharCode(...new Uint8Array(mem.buffer, offset, len));
    };

    /**
     * @param {string} filename
     * @param {Object} options
     * @param {number=} n_tries
     */
    function load_file(filename, options, n_tries)
    {
        var http = new XMLHttpRequest();

        http.open(options.method || "get", filename, true);

        if(options.as_json)
        {
            http.responseType = "json";
        }
        else
        {
            http.responseType = "arraybuffer";
        }

        if(options.headers)
        {
            var header_names = Object.keys(options.headers);

            for(var i = 0; i < header_names.length; i++)
            {
                var name = header_names[i];
                http.setRequestHeader(name, options.headers[name]);
            }
        }

        if(options.range)
        {
            let start = options.range.start;
            let end = start + options.range.length - 1;
            http.setRequestHeader("Range", "bytes=" + start + "-" + end);

            // Abort if server responds with complete file in response to range
            // request, to prevent downloading large files from broken http servers
            http.onreadystatechange = function()
            {
                if(http.status === 200)
                {
                    http.abort();
                }
            };
        }

        http.onload = function(e)
        {
            if(http.readyState === 4)
            {
                if(http.status !== 200 && http.status !== 206)
                {
                    console.error("Loading the image " + filename + " failed (status %d)", http.status);
                    if(http.status >= 500 && http.status < 600)
                    {
                        retry();
                    }
                }
                else if(http.response)
                {
                    options.done && options.done(http.response, http);
                }
            }
        };

        http.onerror = function(e)
        {
            console.error("Loading the image " + filename + " failed", e);
            retry();
        };

        if(options.progress)
        {
            http.onprogress = function(e)
            {
                options.progress(e);
            };
        }

        http.send(null);

        function retry()
        {
            const number_of_tries = n_tries || 0;
            const timeout = [1, 1, 2, 3, 5, 8, 13, 21][number_of_tries] || 34;
            setTimeout(() => {
                load_file(filename, options, number_of_tries + 1);
            }, 1000 * timeout);
        }
    }

    function load_file_nodejs(filename, options)
    {
        let fs = require("fs");

        if(options.range)
        {
            dbg_assert(!options.as_json);

            fs["open"](filename, "r", (err, fd) =>
            {
                if(err) throw err;

                let length = options.range.length;
                var buffer = Buffer.allocUnsafe(length);

                fs["read"](fd, buffer, 0, length, options.range.start, (err, bytes_read) =>
                {
                    if(err) throw err;

                    dbg_assert(bytes_read === length);
                    options.done && options.done(new Uint8Array(buffer));

                    fs["close"](fd, (err) => {
                        if(err) throw err;
                    });
                });
            });
        }
        else
        {
            var o = {
                encoding: options.as_json ? "utf-8" : null,
            };

            fs["readFile"](filename, o, function(err, data)
            {
                if(err)
                {
                    console.log("Could not read file:", filename, err);
                }
                else
                {
                    var result = data;

                    if(options.as_json)
                    {
                        result = JSON.parse(result);
                    }
                    else
                    {
                        result = new Uint8Array(result).buffer;
                    }

                    options.done(result);
                }
            });
        }
    }

    if(typeof XMLHttpRequest === "undefined")
    {
        var determine_size = function(path, cb)
        {
            require("fs")["stat"](path, (err, stats) =>
            {
                if(err)
                {
                    cb(err);
                }
                else
                {
                    cb(null, stats.size);
                }
            });
        };
    }
    else
    {
        var determine_size = function(url, cb)
        {
            v86util.load_file(url, {
                done: (buffer, http) =>
                {
                    var header = http.getResponseHeader("Content-Range") || "";
                    var match = header.match(/\/(\d+)\s*$/);

                    if(match)
                    {
                        cb(null, +match[1]);
                    }
                    else
                    {
                        const error = "`Range: bytes=...` header not supported (Got `" + header + "`)";
                        cb(error);
                    }
                },
                headers: {
                    Range: "bytes=0-0",
                }
            });
        };
    }

    /**
     * Asynchronous access to ArrayBuffer, loading blocks lazily as needed,
     * using the `Range: bytes=...` header
     *
     * @constructor
     * @param {string} filename Name of the file to download
     * @param {number|undefined} size
     */
    function AsyncXHRBuffer(filename, size)
    {
        this.filename = filename;

        /** @const */
        this.block_size = 256;
        this.byteLength = size;

        this.block_cache = new Map();
        this.block_cache_is_write = new Set();

        this.onload = undefined;
        this.onprogress = undefined;
    }

    AsyncXHRBuffer.prototype.load = function()
    {
        if(this.byteLength !== undefined)
        {
            this.onload && this.onload(Object.create(null));
            return;
        }

        // Determine the size using a request

        determine_size(this.filename, (error, size) =>
        {
            if(error)
            {
                throw new Error("Cannot use: " + this.filename + ". " + error);
            }
            else
            {
                dbg_assert(size >= 0);
                this.byteLength = size;
                this.onload && this.onload(Object.create(null));
            }
        });
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
     */
    AsyncXHRBuffer.prototype.get_from_cache = function(offset, len)
    {
        var number_of_blocks = len / this.block_size;
        var block_index = offset / this.block_size;

        for(var i = 0; i < number_of_blocks; i++)
        {
            var block = this.block_cache.get(block_index + i);

            if(!block)
            {
                return;
            }
        }

        if(number_of_blocks === 1)
        {
            return this.block_cache.get(block_index);
        }
        else
        {
            var result = new Uint8Array(len);
            for(var i = 0; i < number_of_blocks; i++)
            {
                result.set(this.block_cache.get(block_index + i), i * this.block_size);
            }
            return result;
        }
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncXHRBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset + len <= this.byteLength);
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len);
        if(block)
        {
            if(ASYNC_SAFE)
            {
                setTimeout(fn.bind(this, block), 0);
            }
            else
            {
                fn(block);
            }
            return;
        }

        v86util.load_file(this.filename, {
            done: function done(buffer)
            {
                var block = new Uint8Array(buffer);
                this.handle_read(offset, len, block);
                fn(block);
            }.bind(this),
            range: { start: offset, length: len },
        });
    };

    /**
     * Relies on this.byteLength, this.block_cache and this.block_size
     *
     * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
     *
     * @param {number} start
     * @param {!Uint8Array} data
     * @param {function()} fn
     */
    AsyncXHRBuffer.prototype.set = function(start, data, fn)
    {
        console.assert(start + data.byteLength <= this.byteLength);

        var len = data.length;

        console.assert(start % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var start_block = start / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            var block = this.block_cache.get(start_block + i);

            if(block === undefined)
            {
                block = new Uint8Array(this.block_size);
                this.block_cache.set(start_block + i, block);
            }

            var data_slice = data.subarray(i * this.block_size, (i + 1) * this.block_size);
            block.set(data_slice);

            console.assert(block.byteLength === data_slice.length);

            this.block_cache_is_write.add(start_block + i);
        }

        fn();
    };

    /**
     * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
     * @param {number} offset
     * @param {number} len
     * @param {!Uint8Array} block
     */
    AsyncXHRBuffer.prototype.handle_read = function(offset, len, block)
    {
        // Used by AsyncXHRBuffer, AsyncXHRPartfileBuffer and AsyncFileBuffer
        // Overwrites blocks from the original source that have been written since

        var start_block = offset / this.block_size;
        var block_count = len / this.block_size;

        for(var i = 0; i < block_count; i++)
        {
            const cached_block = this.block_cache.get(start_block + i);

            if(cached_block)
            {
                block.set(cached_block, i * this.block_size);
            }
            else if(this.cache_reads)
            {
                const cached = new Uint8Array(this.block_size);
                cached.set(block.subarray(i * this.block_size, (i + 1) * this.block_size));
                this.block_cache.set(start_block + i, cached);
            }
        }
    };

    AsyncXHRBuffer.prototype.get_buffer = function(fn)
    {
        // We must download all parts, unlikely a good idea for big files
        fn();
    };

    ///**
    // * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
    // */
    //AsyncXHRBuffer.prototype.get_block_cache = function()
    //{
    //    var count = Object.keys(this.block_cache).length;

    //    var buffer = new Uint8Array(count * this.block_size);
    //    var indices = [];

    //    var i = 0;
    //    for(var index of Object.keys(this.block_cache))
    //    {
    //        var block = this.block_cache.get(index);
    //        dbg_assert(block.length === this.block_size);
    //        index = +index;
    //        indices.push(index);
    //        buffer.set(
    //            block,
    //            i * this.block_size
    //        );
    //        i++;
    //    }

    //    return {
    //        buffer,
    //        indices,
    //        block_size: this.block_size,
    //    };
    //};

    /**
     * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
     */
    AsyncXHRBuffer.prototype.get_state = function()
    {
        const state = [];
        const block_cache = [];

        for(let [index, block] of this.block_cache)
        {
            dbg_assert(isFinite(index));
            if(this.block_cache_is_write.has(index))
            {
                block_cache.push([index, block]);
            }
        }

        state[0] = block_cache;
        return state;
    };

    /**
     * @this {AsyncXHRBuffer|AsyncXHRPartfileBuffer|AsyncFileBuffer}
     */
    AsyncXHRBuffer.prototype.set_state = function(state)
    {
        const block_cache = state[0];
        this.block_cache.clear();
        this.block_cache_is_write.clear();

        for(let [index, block] of block_cache)
        {
            dbg_assert(isFinite(index));
            this.block_cache.set(index, block);
            this.block_cache_is_write.add(index);
        }
    };

    /**
     * Asynchronous access to ArrayBuffer, loading blocks lazily as needed,
     * downloading files named filename-%d-%d.ext (where the %d are start and end offset).
     * Or, if partfile_alt_format is set, filename-%08d.ext (where %d is the part number, compatible with gnu split).
     *
     * @constructor
     * @param {string} filename Name of the file to download
     * @param {number|undefined} size
     * @param {number|undefined} fixed_chunk_size
     * @param {boolean|undefined} partfile_alt_format
     */
    function AsyncXHRPartfileBuffer(filename, size, fixed_chunk_size, partfile_alt_format)
    {
        const parts = filename.match(/(.*)(\..*)/);

        if(parts)
        {
            this.basename = parts[1];
            this.extension = parts[2];
        }
        else
        {
            this.basename = filename;
            this.extension = "";
        }

        /** @const */
        this.block_size = 256; // TODO: Could probably be set to fixed_chunk_size if present
        this.block_cache = new Map();
        this.block_cache_is_write = new Set();

        this.byteLength = size;
        this.fixed_chunk_size = fixed_chunk_size;
        this.partfile_alt_format = !!partfile_alt_format;

        this.cache_reads = !!fixed_chunk_size; // TODO: could also be useful in other cases (needs testing)

        this.onload = undefined;
        this.onprogress = undefined;
    }

    AsyncXHRPartfileBuffer.prototype.load = function()
    {
        if(this.byteLength !== undefined)
        {
            this.onload && this.onload(Object.create(null));
            return;
        }
        dbg_assert(false);
        this.onload && this.onload(Object.create(null));
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncXHRPartfileBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset + len <= this.byteLength);
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        const block = this.get_from_cache(offset, len);

        if(block)
        {
            if(ASYNC_SAFE)
            {
                setTimeout(fn.bind(this, block), 0);
            }
            else
            {
                fn(block);
            }
            return;
        }

        if(this.fixed_chunk_size)
        {
            const start_index = Math.floor(offset / this.fixed_chunk_size);
            const m_offset = offset - start_index * this.fixed_chunk_size;
            dbg_assert(m_offset >= 0);
            const total_count = Math.ceil((m_offset + len) / this.fixed_chunk_size);
            const blocks = new Uint8Array(total_count * this.fixed_chunk_size);
            let finished = 0;

            for(let i = 0; i < total_count; i++)
            {
                const offset = (start_index + i) * this.fixed_chunk_size;

                const part_filename =
                    this.partfile_alt_format ?
                        // matches output of gnu split:
                        //   split -b 512 -a8 -d --additional-suffix .img w95.img w95-
                        this.basename + "-" + (start_index + i + "").padStart(8, "0") + this.extension
                    :
                        this.basename + "-" + offset + "-" + (offset + this.fixed_chunk_size) + this.extension;

                // XXX: unnecessary allocation
                const block = this.get_from_cache(offset, this.fixed_chunk_size);

                if(block)
                {
                    const cur = i * this.fixed_chunk_size;
                    blocks.set(block, cur);
                    finished++;
                    if(finished === total_count)
                    {
                        const tmp_blocks = blocks.subarray(m_offset, m_offset + len);
                        fn(tmp_blocks);
                    }
                }
                else
                {
                    v86util.load_file(part_filename, {
                        done: function done(buffer)
                        {
                            const cur = i * this.fixed_chunk_size;
                            const block = new Uint8Array(buffer);
                            this.handle_read((start_index + i) * this.fixed_chunk_size, this.fixed_chunk_size|0, block);
                            blocks.set(block, cur);
                            finished++;
                            if(finished === total_count)
                            {
                                const tmp_blocks = blocks.subarray(m_offset, m_offset + len);
                                fn(tmp_blocks);
                            }
                        }.bind(this),
                    });
                }
            }
        }
        else
        {
            const part_filename = this.basename + "-" + offset + "-" + (offset + len) + this.extension;

            v86util.load_file(part_filename, {
                done: function done(buffer)
                {
                    dbg_assert(buffer.byteLength === len);
                    var block = new Uint8Array(buffer);
                    this.handle_read(offset, len, block);
                    fn(block);
                }.bind(this),
            });
        }
    };

    AsyncXHRPartfileBuffer.prototype.get_from_cache = AsyncXHRBuffer.prototype.get_from_cache;
    AsyncXHRPartfileBuffer.prototype.set = AsyncXHRBuffer.prototype.set;
    AsyncXHRPartfileBuffer.prototype.handle_read = AsyncXHRBuffer.prototype.handle_read;
    //AsyncXHRPartfileBuffer.prototype.get_block_cache = AsyncXHRBuffer.prototype.get_block_cache;
    AsyncXHRPartfileBuffer.prototype.get_state = AsyncXHRBuffer.prototype.get_state;
    AsyncXHRPartfileBuffer.prototype.set_state = AsyncXHRBuffer.prototype.set_state;

    /**
     * Synchronous access to File, loading blocks from the input type=file
     * The whole file is loaded into memory during initialisation
     *
     * @constructor
     */
    function SyncFileBuffer(file)
    {
        this.file = file;
        this.byteLength = file.size;

        if(file.size > (1 << 30))
        {
            console.warn("SyncFileBuffer: Allocating buffer of " + (file.size >> 20) + " MB ...");
        }

        this.buffer = new ArrayBuffer(file.size);
        this.onload = undefined;
        this.onprogress = undefined;
    }

    SyncFileBuffer.prototype.load = function()
    {
        this.load_next(0);
    };

    /**
     * @param {number} start
     */
    SyncFileBuffer.prototype.load_next = function(start)
    {
        /** @const */
        var PART_SIZE = 4 << 20;

        var filereader = new FileReader();

        filereader.onload = function(e)
        {
            var buffer = new Uint8Array(e.target.result);
            new Uint8Array(this.buffer, start).set(buffer);
            this.load_next(start + PART_SIZE);
        }.bind(this);

        if(this.onprogress)
        {
            this.onprogress({
                loaded: start,
                total: this.byteLength,
                lengthComputable: true,
            });
        }

        if(start < this.byteLength)
        {
            var end = Math.min(start + PART_SIZE, this.byteLength);
            var slice = this.file.slice(start, end);
            filereader.readAsArrayBuffer(slice);
        }
        else
        {
            this.file = undefined;
            this.onload && this.onload({ buffer: this.buffer });
        }
    };

    /**
     * @param {number} start
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    SyncFileBuffer.prototype.get = function(start, len, fn)
    {
        console.assert(start + len <= this.byteLength);
        fn(new Uint8Array(this.buffer, start, len));
    };

    /**
     * @param {number} offset
     * @param {!Uint8Array} slice
     * @param {function()} fn
     */
    SyncFileBuffer.prototype.set = function(offset, slice, fn)
    {
        console.assert(offset + slice.byteLength <= this.byteLength);

        new Uint8Array(this.buffer, offset, slice.byteLength).set(slice);
        fn();
    };

    SyncFileBuffer.prototype.get_buffer = function(fn)
    {
        fn(this.buffer);
    };

    SyncFileBuffer.prototype.get_state = function()
    {
        const state = [];
        state[0] = this.byteLength;
        state[1] = new Uint8Array(this.buffer);
        return state;
    };

    SyncFileBuffer.prototype.set_state = function(state)
    {
        this.byteLength = state[0];
        this.buffer = state[1].slice().buffer;
    };

    /**
     * Asynchronous access to File, loading blocks from the input type=file
     *
     * @constructor
     */
    function AsyncFileBuffer(file)
    {
        this.file = file;
        this.byteLength = file.size;

        /** @const */
        this.block_size = 256;
        this.block_cache = new Map();
        this.block_cache_is_write = new Set();

        this.onload = undefined;
        this.onprogress = undefined;
    }

    AsyncFileBuffer.prototype.load = function()
    {
        this.onload && this.onload(Object.create(null));
    };

    /**
     * @param {number} offset
     * @param {number} len
     * @param {function(!Uint8Array)} fn
     */
    AsyncFileBuffer.prototype.get = function(offset, len, fn)
    {
        console.assert(offset % this.block_size === 0);
        console.assert(len % this.block_size === 0);
        console.assert(len);

        var block = this.get_from_cache(offset, len);
        if(block)
        {
            fn(block);
            return;
        }

        var fr = new FileReader();

        fr.onload = function(e)
        {
            var buffer = e.target.result;
            var block = new Uint8Array(buffer);

            this.handle_read(offset, len, block);
            fn(block);
        }.bind(this);

        fr.readAsArrayBuffer(this.file.slice(offset, offset + len));
    };
    AsyncFileBuffer.prototype.get_from_cache = AsyncXHRBuffer.prototype.get_from_cache;
    AsyncFileBuffer.prototype.set = AsyncXHRBuffer.prototype.set;
    AsyncFileBuffer.prototype.handle_read = AsyncXHRBuffer.prototype.handle_read;
    AsyncFileBuffer.prototype.get_state = AsyncXHRBuffer.prototype.get_state;

    AsyncFileBuffer.prototype.get_buffer = function(fn)
    {
        // We must load all parts, unlikely a good idea for big files
        fn();
    };

    AsyncFileBuffer.prototype.get_as_file = function(name)
    {
        var parts = [];
        var existing_blocks = Array.from(this.block_cache.keys()).sort(function(x, y) { return x - y; });

        var current_offset = 0;

        for(var i = 0; i < existing_blocks.length; i++)
        {
            var block_index = existing_blocks[i];
            var block = this.block_cache.get(block_index);
            var start = block_index * this.block_size;
            console.assert(start >= current_offset);

            if(start !== current_offset)
            {
                parts.push(this.file.slice(current_offset, start));
                current_offset = start;
            }

            parts.push(block);
            current_offset += block.length;
        }

        if(current_offset !== this.file.size)
        {
            parts.push(this.file.slice(current_offset));
        }

        var file = new File(parts, name);
        console.assert(file.size === this.file.size);

        return file;
    };

})();
