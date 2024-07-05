const { default: axios } = require("axios");
const unzipper = require('unzipper');
const { load } = require("cheerio");
const { sendResp, getScore} = require("../middlewares/common-utils");
const constatns = require('../middlewares/constatns.json');
const { redisClient } = require("../config/redis.config");
const { mongoClient } = require('../config/db.config');
const fs = require('fs');
require("dotenv").config();

const url = process.env.CSES_URI;
const coderuner = process.env.CODERUNNER_URI

const csesDB = mongoClient.db('codenest').collection('cses');

const searchProblem = async (req, res) => {
    const prblm_str = req.body.problem;
    var all_problems = [];
    if (prblm_str.length >= 3) {
        await axios.get(url + '/problemset').then((resp) => {
            if (resp.status === 200) {
                const $ = load(resp.data);
                $('.task').each((index, element) => {
                    const category = $(element).parent().prev('h2').text();
                    const link = $(element).children('a').attr('href');
                    const name = $(element).children('a').text();
                    const detail = $(element).children('.detail').text();
                    all_problems.push({ name: name, category: category, link: link, detail: detail, score: getScore(prblm_str.toLowerCase(), name.toLowerCase(), prblm_str.length, name.length) });
                })
            }
        })
        all_problems.sort((a, b) => {
            return b.score - a.score;
        });
    }
    sendResp(res, all_problems.slice(0, process.env.SEARCH_LIMIT), "OK", 200);
}

const getProblem = async (req, res) => {

    const problemId = req.body.problemId;

    await axios.get(url + "/problemset/task/" + problemId)
        .then((resp) => {
            if (resp.status === 200) {
                const $ = load(resp.data);
                $('img').each((index, element) => {
                    let text = $(element).attr('src');
                    text = "https://cses.fi/" + text;
                    $(element).attr('src', text);
                });
                $('.md').append('<script defer src="https://cdn.jsdelivr.net/npm/katex@0.11.1/dist/katex.min.js" integrity="sha384-y23I5Q6l+B6vatafAwxRu/0oK/79VlbSz7Q9aiSZUvyWYIYsd+qj+o24G5ZU2zJz" crossorigin="anonymous"></script>')
                $('.md').append('<script defer src="https://cdn.jsdelivr.net/npm/katex@0.11.1/dist/contrib/auto-render.min.js" integrity="sha384-kWPLUVMOks5AQFrykwIup5lo0m3iMkkHrD0uJ4H5cjeGihAutqP0yW0J6dpFiVkI" crossorigin="anonymous" onload="renderMathInElement(document.body);"></script>');
                res.send($('.md').html());
            }
        })
}

const getTestCases = async (request, finalResp) => {

    const problem = request.body.problemId;

    const response = await getTestCasesImpl(problem);

    await sendResp(finalResp,response.result,response.status,response.code);
}

const runCode = async (req, res) => {

    var result;

    const userId = req.body.userId;
    const lang = req.body.lang;
    const code = req.body.code;
    const input = req.body.input;

    try{
        result = await axios.post(`${coderuner}/runCode`,{
            userId:userId,
            lang:lang,
            code:code,
            input:input
        })
    }catch(err){
        sendResp(res,err.message,"OK",200);
        return;
    }

    await sendResp(res, result.data, constatns.SUCESS, 200);
    
}

const submitProblem = async (req, res) => {
    
    const userId = req.body.userId;
    const problemId = req.body.problemId;
    const lang = req.body.lang;
    const code = req.body.code;

    const {ssid,csrf} = await getSession();

    const result = await runTestCases(userId,lang,code,problemId,ssid,csrf);

    await csesDB.insertOne({userId:userId,problemId:problemId,lang:lang,code:code,result:result});

    await sendResp(res,result,"OK",200);

}

const runTestCases = async (userId,lang,code,problemId,ssid,csrf)=>{
    const testResult = await axios.post(`${coderuner}/submitCode`,{
        userId:userId,
        lang:lang,
        code:code,
        problemId:problemId,
        ssid:ssid,
        csrf:csrf
    });
    return testResult.data;
}

const getSubmissions = async (req, res) => {

    const userId = req.body.userId;

    const result = [];

    await csesDB.find({userId:userId}).sort({ time: -1 }).forEach((doc)=>{
        result.push(doc);
    })

    await sendResp(res,result,"OK",200);
}

const getSession = async () => {    

    var ssid = await redisClient.get("PHPID");
    var csrf = await redisClient.get("LCSRF");

    if(ssid==null || ssid==undefined){

        await axios.get(url)
        .then((resp) => {
            ssid = resp.headers['set-cookie'][0].split(";")[0].split("=")[1];
        }).catch((err)=>{
            console.error("error during getting ssid : ",err.message);
        })
        
        await axios.get('https://cses.fi/login',{
            headers:{
                'Cookie': `PHPSESSID=${ssid}`
            }
        }).then((resp) => {
            const $ = load(resp.data);
            csrf = $('input').attr('name','csrf_token').attr('value');
        }).catch((err)=>{
            console.error("error during getting csrf : ",err.message);
        })

        return await csesLogin(ssid,csrf);
    }

    return {ssid,csrf};

}

const csesLogin = async (ssid,csrf)=>{

    let data = {
        csrf_token: csrf,
        nick: process.env.CSES_USERNAME,
        pass: process.env.CSES_PASSWORD 
    }
    let config = {
        headers:{
        'Content-Type': 'application/x-www-form-urlencoded', 
        'Cookie': `PHPSESSID=${ssid}; PHPSESSID=e3a590b7c2cd8c2faed893ccfa75f277f8360b7b`
        }
    }

    const response = await axios.post('https://cses.fi/login',data,config);

    if(response.data == "Wrong CSRF token"){
        console.error(response.data);
        return {};
    }else{
        await redisClient.set("PHPID",ssid);
        await redisClient.set("LCSRF",csrf);
        await redisClient.expire("PHPID",process.env.PHPSID_TTL);
        await redisClient.expire("LCSRF",process.env.PHPSID_TTL);
        return {ssid,csrf};
    }
}


const addTestCase = (problem)=>{

    return new Promise(async (resolve,reject)=>{
        
        var results = [];

        const {ssid,csrf} = await getSession();
        console.log("SSID : "+ssid,"CSRF : "+csrf);

        if(ssid == null || csrf == null){
            resolve({
                result:"SSID or CSRF IS NULL",
                status:"OK",
                code:500
            })
        }

        const response = await axios({
            method: 'post',
            url: url+'/problemset/tests/' + problem,
            responseType: 'stream',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': `PHPSESSID=${ssid}`
            },
            data: {
                csrf_token: `${csrf}`,
                download: "true",
            }
        })

        await response.data.pipe(unzipper.Parse())
    .on('entry', entry => {
        const fileName = entry.path;
        const type = entry.type;
        
        if (type === 'File') {
            if (fileName.endsWith('.in')) {
                let fileContent = {
                    name: fileName.slice(0, -3),
                    input: '',
                    output: ''
                };
                let chunks = [];
                
                entry.on('data', chunk => {
                    chunks.push(chunk);
                });
                
                entry.on('end', () => {
                    fileContent.input = Buffer.concat(chunks).toString('ascii');
                    results.push(fileContent);
                });
            } else if (fileName.endsWith('.out')) {
                let fileNameWithoutExt = fileName.slice(0, -4);
                let chunks = [];
                
                entry.on('data', chunk => {
                    chunks.push(chunk);
                });
                
                entry.on('end', () => {
                    let file = results.find(e => e.name === fileNameWithoutExt);
                    if (file) {
                        file.output += Buffer.concat(chunks).toString('ascii');
                    }
                });
            }
        } else {
            entry.autodrain();
        }
    }).on('close', async () => {
        await csesDB.insertOne({type:"testCases",problemId:problem,testCases:results});
        await csesDB.insertOne({type:"testCaseBool",problemId:problem});
        resolve({
            result: results,
            status: "OK",
            code: 200
        });
    });
    })
}

const getTestCasesImpl = async (problem)=>{

    return new Promise(async (resolve,reject)=>{

        var data = await csesDB.findOne({type:"testCaseBool",problemId:problem});

        if(data!=null && data!=undefined){
            data = await csesDB.findOne({type:"testCases",problemId:problem});
            resolve({
                result: data.testCases,
                status: "OK",
                code: 200
            });
            return;
        }

        const resp = await addTestCase(problem);
        resolve(resp);
    })

}


module.exports = { searchProblem, getProblem, submitProblem, runCode, getSubmissions, getTestCases }