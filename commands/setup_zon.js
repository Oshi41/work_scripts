#!/usr/bin/env node
const yargs_root = require("yargs");
const path = require("path");
const os = require('os');
const fs = require('fs');
const diff = require('diff');
const _ = require('lodash');
const {zrequire, parse_cvs_status, exec_and_record: r_exec, readline,
    get_zon_root} = require("../utils.js");
const etask = zrequire('../../util/etask.js');
const exec = zrequire('../../util/exec.js');
const config_dir = path.join(os.homedir(), 'setup_zon');
if (!fs.existsSync(config_dir))
    fs.mkdirSync(config_dir);
const config_path = path.join(config_dir, 'config.json');
const patch_dir = path.join(config_dir, 'patches');
if (!fs.existsSync(patch_dir))
    fs.mkdirSync(patch_dir);

const exec_and_record = (args, opt, file, descr) => {
    if (opt.hdr) {
        let hdr = `[${opt.hdr}]`;
        opt.log = d => console.log(hdr, d.toString());
        delete opt.hdr;
    }
    return r_exec(() => etask(function* () {
        let sys_opts = {
            env: process.env,
            stdall: 'pipe',
            encoding: 'utf8',
            ..._.omit(opt, ['log']),
        };
        if (opt.transparent_log)
            sys_opts.log = d=>console.log(d.toString('utf-8'));
        let res = yield exec.sys(args, sys_opts);
        if (res.retval) {
            throw new Error(res.stderr.toString());
        }
        return res;
    }), file, descr, opt);
};
const read_map = (filepath)=>{
    if (!fs.existsSync(filepath))
        return;
    let json = fs.readFileSync(filepath, 'utf-8');
    json = JSON.parse(json);
    let result = new Map();
    Object.entries(json).forEach(x=>result.set(...x));
    result.filepath = filepath;
    return result;
};
const save_map = (filepath, map)=>{
    let obj = Array.from(map.entries()).reduce((p, [key, val])=>
        Object.assign(p, {[key]: val}), {});
    map.filepath = filepath;
    let dir = path.dirname(filepath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir);
    fs.writeFileSync(filepath, JSON.stringify(obj, null, 2), 'utf-8');
    return map;
};

const read_patch = etask.fn(function*(root){
    let patch_file = path.join(patch_dir, path.basename(root));
    if (!fs.existsSync(patch_file))
        return;
    return read_map(patch_file);
});

const create_and_save_patch = etask.fn(function*(root){
    let map = yield parse_cvs_status(root);
    let changes = Array.from(map?.entries() || []).filter(([, x]) => x.modified);
    console.log(`Found ${changes.length} changes, creating patches`);
    let result = new Map();
    yield etask.all_limit(10, changes, ([file,]) => etask(function*() {
        let res = yield exec.sys(['cvs', 'diff', '-u', path.basename(file)],
            {
                cwd: path.dirname(file),
                env: process.env,
                stdall: 'pipe',
                encoding: 'utf8',
                log: () => {
                },
            });
        if (!!res.stderr.toString())
            return console.log(res.stderr.toString());
        let diff = res.stdall.toString();
        if (!diff)
            return;

        // Rm such lines
        // RCS file: /arch/cvs/zon/pkg/f1/f2/file.js,v
        // retrieving revision 1.18
        // diff -u -r1.18 file.js
        diff = diff.split('\n');
        diff.splice(2, 3);
        diff = diff.join('\n');
        result.set(file, diff);
    }));
    if (!result.size)
        return;
    return save_map(path.join(patch_dir, path.basename(root)), result);
});

/**
 * @param root {string}
 * @return {Map<string, string>}
 */
const create_or_read_patches = (root) => etask(function* () {
    if (!fs.existsSync(root))
        return;
    root = get_zon_root(root);
    if (!fs.existsSync(root))
        return;
    let result = yield read_patch(root);
    if (!result)
        result = yield create_and_save_patch(root);
    return result;
});

const apply_patches = etask.fn(function(patch_map){
    this.finally(()=>{
       let fp =  patch_map?.filepath;
       if (fs.existsSync(fp))
           fs.rmSync(fp);
    });
    if (patch_map?.filepath)
        patch_map = read_map(patch_map.filepath);
    if (!patch_map?.size)
        return;
    for (let [file, patch_raw] of patch_map) {
        if (!fs.existsSync(file))
            continue;
        let content = fs.readFileSync(file, 'utf-8');
        try {
            let patches = diff.parsePatch(patch_raw);
            for (let patch of patches)
                content = diff.applyPatch(content, patch);
            if (typeof content == 'string')
            {
                fs.writeFileSync(file, content, 'utf-8');
                console.log('Apply patch for', file);
            }
        } catch (e) {
            console.error(e);
        }
    }
});

const check_zlxc_proc = (cwd) => etask(function* () {
    let res = yield exec_and_record(['ps', '-aux'], {cwd, hdr: 'zlxc run status'},
        'ps', '-aux');
    let regex = new RegExp(`node.+zon${process.argv[2]}.+zlxc.+run`);
    let proc = res.stdall.toString().split('\n').filter(x => regex.test(x));
    if (proc.length) {
        let zlxc_run = proc[0].substring(proc[0].indexOf('run '));
        console.log('stopping zlxc...');
        yield exec_and_record(['zlxc', 'stop'], {cwd, hdr: 'zlxc stop'},
            'zlxc', 'stop');
        return zlxc_run;
    }
});

/**
 * @return {{jmake_config: string, build_name: string}}
 */
const read_config = etask.fn(function*(opt){
    if (!fs.existsSync(config_path))
        fs.writeFileSync(config_path, '{}', 'utf-8');

    let json = JSON.parse(fs.readFileSync(config_path, 'utf-8'));
    if (!json.jmake_config || opt.overwrite)
    {
        json.jmake_config = yield readline('Provide default configuration '
            +'for release', json.jmake_config, 'string');
    }
    if (!json.build_name || opt.overwrite)
    {
        json.build_name = yield readline('Provide default release name',
            json.build_name, 'string');
    }
    fs.writeFileSync(config_path, JSON.stringify(json, null, 2), 'utf-8');
    return json;
});

const run = {
    command: '$0',
    args: '<id>',
    describe: 'Reinstall zon folder',
    builder: yargs => yargs.positional('id', {describe: 'zon prefix'})
        .option('overwrite', {
            alias: 'o',
            type: 'boolean',
            default: false,
            describe: 'Override default config values',
        })
        .option('clear', {
            alias: 'c',
            type: 'boolean',
            default: false,
            describe: 'Do not save pending changes',
        })
    ,
    handler: (opt) => etask(function* () {
        this.on('uncaught', console.error.bind(console));
        this.finally(() => console.log('DONE'));

        let {jmake_config, build_name} = yield read_config(opt);

        let base_path = os.homedir();
        let zone_dir = path.join(base_path, 'zon' + opt._[0]);

        const patches_map = opt.clear ? new Map() : yield create_or_read_patches(zone_dir);
        const zlxc = yield check_zlxc_proc(zone_dir);

        if (fs.existsSync(zone_dir)) {
            yield exec_and_record(['rm', '-rf', zone_dir],
                {hdr: 'rm folder'}, '_rm_root', '-rf');
        }

        yield exec_and_record(['cp', '-a', path.join(base_path, '.zon'), zone_dir],
            {hdr: '.zon copy'}, '_root_copy', '-a');

        yield apply_patches(patches_map);

        process.env.BUILD = 'app';
        yield exec_and_record(['jtools', 'jselbuild', '-c', build_name],
            {cwd: zone_dir, hdr: 'choose build'}, '_sb', '-c');
        yield exec_and_record(['jmake', 'config', jmake_config],
            {cwd: zone_dir, hdr: 'customize build'}, 'jmake', 'config');
        yield exec_and_record(['cvsup'],
            {cwd: zone_dir, hdr: 'cvsup'}, 'cvsup', '');
        yield exec_and_record(['jmake', 'cm', 'release'],
            {cwd: zone_dir, hdr: 'build release'}, 'jmake', 'cm release');

        if (zlxc) {
            console.log('Running zlxc...');
            yield exec_and_record(['zlxc', ...zlxc.split(' ')],
                {cwd: zone_dir, transparent_log: true,}, 'zlxc', zlxc);
        }
    }),
};

yargs_root
    .command(run)
    .completion('bash_completion', false)
    .help()
    .demandCommand()
    .recommendCommands()
    .wrap(yargs_root.terminalWidth())
    .argv;