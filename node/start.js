/*

pm2 logs 0 &
pm2 restart 0


c /home/kai/projects/20.03.25_Public2/node/
node start.js

instanciable subClassOf class
{"f":"ce0b87e4","T":"2c90c5b8","t":"7ee96d65","c":"d086fe37","d":1589110147964}


*/


var MiniSearch = MiniSearch || require('minisearch'); // already defined on the frontend version

var _ = require('lodash');
var {Promises,ServerContext,fulltextSearch,resetFulltextSearchObject,
  randHex,valueToString,Claim,Node,makeNode,stridToNode,$$,valueToHtml,makeUnique,_idToNodeIndex,_classes,_supClasses,
  _object,_anything,_instanceOf,_instanciable,_claimType,_typeFrom,_typeTo,_jsMethod,
  ClaimStore,importClaims,
  garbageCollect,_stridClaims,
WebSocketHandler,} = require('./public/core.js');

const fetch = require("node-fetch");
var fs = require('fs');
const {promisify} = require('util');
var fss = {};
fss.readdir = promisify(fs.readdir);
fss.readFile = promisify(fs.readFile);
fss.writeFile = promisify(fs.writeFile);
fss.rename = promisify(fs.rename);
var exec = promisify(require('child_process').exec);



class WorkerPool
{
  constructor(limit=10)
  {
    this.limit = limit;
    this.workerCount = 0;
  }
  setWorker(worker)
  {
    this.worker = worker;
    return this;
  }
  async unlocked()
  {
    while(this.lock) await this.lock;
  }
  // unlocked() must be waited upon first
  async process(item)
  {
    // lock
    if(this.workerCount+1 >= this.limit)
    {
      // console.log("WorkerPool.process()","LOCKING","this.workerCount",this.workerCount);
      this.lock = Promises.resolvablePromise();
    }
    else 
      // console.log("WorkerPool.process()","NOT locking","this.workerCount",this.workerCount);
    
    this.workerCount++;
    var id = this.workerCount;
    // if(this.name) console.log(this.name,"Worker",id,"START","count",this.workerCount);
    var result;
    try
    {
      result = await this.worker(item);
    }
    catch(error)
    {
      result = {type:'error',error,item};
    }
    this.workerCount--;
    // if(this.name) console.log(this.name,"Worker",id,"DONE","count",this.workerCount);

    // unlock
    if(this.lock)
    {
      this.lock.resolve();
      this.lock = undefined;
    }

    return result;
  }

}
Promises.WorkerPool = WorkerPool;



















/*

Import timing:
reading the file: 500
parsing json: +1000
turning into nodes and claims: +1150 (nodes are indexed for uniqueness, claims aren't, although not indexing makes little difference) (eval(js) takes +250)
indexing into ClaimStore (hashish): +250
indexing into SortedSet: +600
indexing claims into nodes: +700 (maps of maps of arrays, from-type and type-from) 


*/














// overwritten right after
// Claim.onNewClaim = claim=>
// {
//   console.log("Claim.onNewClaim() FROM DISK","ClaimID",claim.id,claim.idStr);
// }



var fulltextSearchCache = './fullTextIndex.cache.json';
async function persistFullTextIndexNow()
{
  console.log("persistFullTextIndexNow()");
  var fullTextOptions = fulltextSearch.__options;
  var fullText = fulltextSearch.toJSON();
  var documents = fulltextSearch.documentById;
  fss.writeFile(fulltextSearchCache,JSON.stringify({fullTextOptions,fullText,documents}),'utf8');
  console.log("persistFullTextIndexNow()",'done');
}
// technically, an object can be created, persisted, and the server killed before those 3 seconds (hence an object not indexed)
var persistFullTextIndexDebounced = _.debounce(persistFullTextIndexNow,3000,{maxWait:120000});

var loadingFullTextFromDisk = fs.existsSync(fulltextSearchCache);
if(loadingFullTextFromDisk)
{
  console.log("Loading fullTextIndex from disk…");
  var fulltextSearchCacheStr = fs.readFileSync(fulltextSearchCache,{encoding:'utf8'});
  var {fullTextOptions,fullText,documents} = JSON.parse(fulltextSearchCacheStr);
  console.log("Loading fullTextIndex from disk…",'loaded JSON.');
  fulltextSearch = MiniSearch.loadJSON(JSON.stringify(fullText),fullTextOptions);
  fulltextSearch.__options = fullTextOptions;
  fulltextSearch.documentById = documents;
  resetFulltextSearchObject(fulltextSearch);
  console.log("Loading fullTextIndex from disk.");
}
fulltextSearch.onDocRemoved = persistFullTextIndexDebounced;
fulltextSearch.onDocAdded = persistFullTextIndexDebounced;





var loadingFromDisk = fs.existsSync("./claims.compact.jsonlist");
if(loadingFromDisk)
{
  var startTime = Date.now();
  console.log("Loading claims from disk…");

  if(loadingFullTextFromDisk) fulltextSearch.skipIndexing = true;
  Claim.hideDeleteLogs = true;
  var claimsStr = fs.readFileSync("./claims.compact.jsonlist",{encoding:'utf8'});
  var claims = claimsStr.split('\n');
  console.log("Loading claims from disk…",'line count:',claims.length-1);
  claims = claims.map((line,i)=>
  {
    if(i%40000==39999) console.log("Loading claims from disk…",Math.round(i/claims.length*100)+'% …');
    if(line.length == 0)return;
    try
    {
      var claim = Claim.fromCompactJson(JSON.parse(line));
    }
    catch(e)
    {
      throw new Error("Problem parsing line "+(i+1)+" "+e.message+" LINE="+line+"\nError's stack: "+e.stack);
    }
    
    // claim.from.addClaim(claim); // might not know about multipleValues on time
    return claim;
  });
  delete Claim.hideDeleteLogs;
  if(loadingFullTextFromDisk) delete fulltextSearch.skipIndexing;
  console.log("Claims loaded from disk.",'line count:',claims.length-1,'final count:',Claim.count,"duration",Date.now()-startTime);
  // console.log("Claims loaded from disk.",'_stridClaims',_.mapValues(_stridClaims,c=>c.from.id),_.size(_stridClaims));
  console.log("Claims loaded from disk.",'_stridClaims',_.size(_stridClaims));


}

// .jsonlist : 1 json object per line (in this case, one claim as .toCompactJson() per line)
var stream  = fs.createWriteStream("./claims.jsonlist",         {flags:'a',encoding: 'utf8'});
var streamC = fs.createWriteStream("./claims.compact.jsonlist", {flags:'a',encoding: 'utf8'});
var recompactingLock;
async function recompactClaimsOnDisk()
{
  console.log("recompactClaimsOnDisk()","...");
  recompactingLock = Promises.resolvablePromise();

  streamC.close();
  var streamC2 = fs.createWriteStream("./claims.compact.jsonlist_tmp", {flags:'a',encoding: 'utf8'});

  // var claims = Claim.mainClaimStore.getAll(true);
  var claims = [...Claim.makeOverallClaimIterator()];
  claims = _.sortBy(claims,c=>c.date.valueOf());
  claims.forEach(claim=>
  {
    var compactJson = claim.toCompactJson();
    var line = JSON.stringify(compactJson) + "\n";
    streamC2.write(line);
  });
  streamC2.close();
  await fss.rename("./claims.compact.jsonlist_tmp","./claims.compact.jsonlist");
  streamC = fs.createWriteStream("./claims.compact.jsonlist", {flags:'a',encoding: 'utf8'});

  console.log("recompactClaimsOnDisk()",".");
  recompactingLock.resolve();
  recompactingLock = undefined;
}

Claim.onNewClaim = async (claim,remove=false)=>
{
  if(recompactingLock) await recompactingLock;
  // if(remove) console.log("Claim.onNewClaim() REMOVE","ClaimID",claim.id,claim.idStr);
  // if(!remove) console.log("Claim.onNewClaim()","ClaimID",claim.id,claim.idStr);
  var compactJson = claim.toCompactJson();
  if(remove) compactJson.del = true;
  var line = JSON.stringify(compactJson) + "\n";
  stream .write(line);
  streamC.write(line);
}
var _kaielvin = $$('kaielvin');

























const express = require('express')
const app = express()
const port = 3000
var bodyParser = require('body-parser');
app.use( bodyParser.json({limit: '50mb'}) );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
}));
var cookieParser = require('cookie-parser');
app.use(cookieParser());
var cors = require('cors')
app.use(cors())
app.use(express.static('public'))


app.get('/all', (req, res) =>
{
  var claimStore = new ClaimStore();
  for(var node of Node.coreNodesIterator())
    claimStore.addAllNodeClaims(node);


  // // keep in sync with object.neededAsCore(), this implementation is faster

  // var excludedClasses = [ // from coreNodes
  //   $$('person'),
  //   $$('resolvable'),
  //   $$('collection'),
  //   $$('descriptorTo'),$$('descriptorFrom'), // legacy
  // ];

  // $$('coreNodes').$froms('object.tags').forEach(coreNode=>
  // {
  //   claimStore.addAllNodeClaims(coreNode);
  //   var classes = coreNode.$(_classes);
  //   console.log("GET /all","adding",coreNode.$('prettyString'),classes.map(c=>c.name).join());
  //   if(classes.includes(_instanciable))
  //   {
  //     var supClasses = coreNode.$(_supClasses);
  //     console.log("GET /all","supClasses:",supClasses.map(c=>c.name).join());
  //     if(!excludedClasses.some(excludedClass=> supClasses.includes(excludedClass) ))
  //       coreNode.$froms(_instanceOf).forEach(node=>
  //       {
  //         claimStore.addAllNodeClaims(node);
  //         console.log("GET /all","adding",node.$('prettyString'));
  //       });
  //   }
  // })


  // var excludedInstanciable = [
  //   $$('YoutubeVideo'),$$('YoutubeChannel'),$$('watching'),
  //   $$('person'),$$('givenName'),$$('surname'),$$('textualMention'),
  //   $$('descriptorTo'),$$('descriptorFrom'),$$('descriptorFullTextSearch')];
  // console.log("GET /all",'excludes',excludedInstanciable.map(i=>i.$('prettyString')).join());
  // // TODO use the main ClaimStore
  // var claimStore = new ClaimStore();
  // for(var fromId in _idToNodeIndex)
  // {
  //   var node = Node.makeById(fromId);
  //   var instanciable = node.$(_instanceOf);
  //   // console.log("GET /all",instanciable&&instanciable.$('prettyString'),instanciable && excludedInstanciable.includes(instanciable));
  //   if(instanciable && excludedInstanciable.includes(instanciable) && node != _kaielvin)
  //     continue;
  //   claimStore.addAllNodeClaims(_idToNodeIndex[fromId]);
  // }
  res.send({compactJson:claimStore.toCompactJson()});

  // res.send({nodes:_.values(_idToNodeIndex).map(node=>nodeToJson(node))});
});

app.listen(port, () => console.log(`Example app listening on port ${port}!`))
console.log("http://localhost:3000/all");


// function nodeToJson(node,includeFroms=false)
// {
//   var id = node.id;

//   // _.mapValues(node.typeTos,(claim,key)=>
//   //   {
//   //     if(key == 'set' || claim.to && claim.claimer) return;
//   //     console.log("to undefined",claim);
//   //     console.log("to undefined",claim.from);
//   //     console.log("to undefined",claim.type);
//   //     throw "stop";
//   //   });


//   var claims = _.mapValues(node.typeTos,tos=>
//   {
//     if(!(tos instanceof Claim))
//       return ({set:_.mapValues(tos,({claimer,date})=>({claimer:claimer.id,date}))});

//     var {to,claimer,date} = tos;
//     to =  to instanceof Node   ? to.id
//         : to.j                 ? {j:String(to.j)}
//         // : to.s                 ? to
//         // : to.n                 ? to
//         :                        to;
//     return {to,claimer:claimer.id,date};
//   });

//   // var claims = _.mapValues(node.typeTos,({to,claimer,date})=>
//   //     to instanceof Node   ? {to:  to.id            ,claimer:claimer.id,date}
//   //   : to.j                 ? {to:  {j:String(to.j)} ,claimer:claimer.id,date}
//   //   : to.s                 ? {to:  to               ,claimer:claimer.id,date}
//   //   : to.n                 ? {to:  to               ,claimer:claimer.id,date}
//   //   :                        ({set:_.mapValues(to,({claimer,date})=>({claimer:claimer.id,date}))}) );
//   var json = {id,claims};
//   // if(includeFroms) json.fromClaims = _.mapValues(node.typeFroms,from_=>from_.id);
//   if(includeFroms) json.fromClaims = _.mapValues(node.typeFroms,({from,claimer,date})=>
//     ({from:from.id,claimer:claimer.id,date}) );
//   return json;
// }






















// (async ()=>
// {
//   await wait(300);

//   $$()
//     .$(_instanceOf,'list')
//     .$ex('push',{n:42})
//     .$ex('push',{n:11});

// })()








const WebSocket = require('ws');
 
const wss = new WebSocket.Server({ port: 8080 });
 
wss.on('connection', function connection(ws)
{
  var handler = new WebSocketHandler(ws);
  console.log("on WS client connection openned.");
  ws.on('close', async function incoming(message)
  {
    console.log("on WS client connection closed.");
  });
  ws.on('message',handler.onMessage);
//   ws.on('message', async function incoming(message)
//   {
//     var message = JSON.parse(message);
//     console.log("on client message",message.request);
//     var response = {requestId:message.requestId,data:[]};
//     var responseClaimsStore = new ClaimStore();
//     if(message.claims) importClaims(message.claims);

//     if(message.request == 'fetchCollection')
//     {
//       var {collection,skip,limit,localIds} = message;
//       collection = $$(collection);
//       if(skip.from) skip.from = Node.makeById(skip.from);
//       var {objects,totalCount} = collection.$ex('resolve',skip,limit,true,localIds);

//       var excludeIdsSet = localIds ? _.keyBy(localIds) : {};
//       objects.forEach(result=>
//       {
//         if(!excludeIdsSet[result.id]) responseClaimsStore.addAllNodeClaims(result,false);
//       });
//       response.results = objects.map(result=>result.id);
//       response.totalCount = totalCount;

//       console.log("wss.fetchCollection",skip.from ? skip.from.id : skip,limit,localIds.length,response.results.length,response.totalCount);
//     }
//     if(message.request == 'fetchNodesById')
//     {
//       var {nodeIds} = message;
//       nodeIds.forEach(nodeId=>
//         responseClaimsStore.addAllNodeClaims(Node.makeById(nodeId),false));
//     }
//     if(message.request == 'deleteNodesById')
//     {
//       var {nodeIds} = message;
//       nodeIds.forEach(nodeId=>
//         Node.makeById(nodeId).delete());
//     }
//     if(message.request == 'fetchYoutubeChannel')
//     {
//       var {channelId} = message;
//       var channel = Node.makeById(channelId);
//       console.log("WS fetchYoutubeChannel()","channel",channel.id,channel.$('prettyString'));
//       var videos = await channel.$ex('fetch');
//       videos.forEach(video=>
//         responseClaimsStore.addAllNodeClaims(videos,false));
//       response.videos = videos.map(v=>v.id);
//     }

// // {descriptor:[["instanceOf","YoutubeVideo"],["strid",vid]]}
//     // if(message.request == "makeYouTubeVideo")
//     // {
//     //   var video = await $$('YoutubeVideo','instanciable.make')(message.vid);
//     //   response.data.push(nodeToJson(video,true));
//     //   response.videoId = video.id;
//     // }

//     if(responseClaimsStore.length > 0)
//       response.claims = responseClaimsStore.toCompactJson();

//     ws.send(JSON.stringify(response));
//   });

});




























var makeYouTubeVideoFromPlaylistDataAndByFetching_Pool = new Promises.WorkerPool(25)
  .setWorker(async vid=> await $$('YoutubeVideo','instanciable.make')(vid,false,true) ); // {alreadyExisted,node}

ServerContext.ensureAllVideosFetched = async (vids,excludeAlreadyExistent=true)=>
{
  var videosPromises = [];
  for(var vid of vids)
  {
      await makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.unlocked();
      videosPromises.push(makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.process(vid));
  }
  var videos = await Promise.all(videosPromises);
  // console.log("cachedFetch_YoutubePlaylistVideos()","videos.length",videos.length);
  videos = videos.filter(video=>
  {
    if(excludeAlreadyExistent && video.alreadyExisted) return false;
    if(!video.error) return true;
    console.error("Failed loading video "+video.item,video.error);
    return false;
  }).map(({node})=>node); // TODO check these changes…
  // console.log("cachedFetch_YoutubePlaylistVideos()","videos.length",videos.length,'.');
  return videos;
}

ServerContext.cachedFetch_YoutubePlaylistVideos = async pid=>
{
  var {extractedJson} = await ServerContext.cachedFetch_YoutubePlaylist2(pid);
  // yeah, that's one long dive:
  var vids = extractedJson.contents
    .twoColumnBrowseResultsRenderer
    .tabs[0].tabRenderer.content
    .sectionListRenderer.contents[0]
    .itemSectionRenderer.contents[0]
    .playlistVideoListRenderer.contents
    .map(obj=>obj.playlistVideoRenderer.videoId);
  return ServerContext.ensureAllVideosFetched(vids);
}


ServerContext.makeYoutubeChannel = (cid,title)=>
{
  var channel = stridToNode(cid);
  if(channel) return channel;
  channel = makeNode(cid).$('instanceOf','YoutubeChannel').$('title',{s:title});
  return channel;
}


var bannedFromYoutube = false;
async function YouTubeHtmlFetch(cacheFolderName,url,id,jsonVariable)
{
  var cachePath = './cache/'+cacheFolderName+'/'+id+'.json';
  if(fs.existsSync(cachePath)) return JSON.parse(await fss.readFile(cachePath));

  if(bannedFromYoutube) throw new Error("banned from YouTube.");

  console.log("YouTubeHtmlFetch()",'url',url,'…');
  // var path = 'https://cors-anywhere.herokuapp.com/'+url;
  var path = 'http://35.180.160.234:4371/'+url; // kaielvin EC2
  // var path = 'http://35.180.55.192:4371/'+url; // micro EC2
  // var path = url;

  var fetched = await fetch(path,{headers:{
      "X-Requested-With":"Chrome",
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9',
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/81.0.4044.113 Safari/537.36",
    }});

  var text = await fetched.text();
  var startStr = 'window["'+jsonVariable+'"] = ';
  var start = text.indexOf(startStr);
  var noStart = start == -1;
  start+= startStr.length;
  var stop = text.indexOf(";\n",start);
  if(noStart || stop == -1)
  {
    if(text.includes("<p class='largeText'>Sorry for the interruption. We have been receiving a large volume of requests from your network.</p>"))
    {
      text = "Sorry for the interruption. We have been receiving a large volume of requests from your network.";
      bannedFromYoutube = true;
    }
    if(text.includes("Our systems have detected unusual traffic from your computer network.  This page checks to see if it&#39;s really you sending the requests, and not a robot."))
    {
      text = "Our systems have detected unusual traffic from your computer network.";
      bannedFromYoutube = true;
    }

    throw new Error('no json information found, path='+path+', returned: '+text);
  }

  // var match = text.match(/window\[\"ytInitialPlayerResponse\"\] = (.*)/);
  // if(!match) await fss.writeFile(cachePath+'.error.html',text,'utf8');
  // if(!match) throw new Error('no json information found, path='+path+', returned: '+text);

  var json = text.substring(start,stop);
  json = JSON.parse(json);


  // console.log('FOUND',json);
  // console.log('FOUND',JSON.stringify(json,null,'    '));

  var result = {};
  result.fetchDate = new Date();
  result.sourceHtml = text;
  result.extractedJson = json;

  await fss.writeFile(cachePath,JSON.stringify(result),'utf8');
  return result;
}
ServerContext.cachedFetch_YoutubeVideo2 = async vid=>
{
  return await YouTubeHtmlFetch('youtube_video_fromHtml','https://www.youtube.com/watch?v='+vid,vid,'ytInitialPlayerResponse');
}
ServerContext.cachedFetch_YoutubePlaylist2 = async pid=>
{
  return await YouTubeHtmlFetch('youtube_playlist_fromHtml','https://www.youtube.com/playlist?list='+pid,pid,'ytInitialData');
}


ServerContext.fetchFromKaielvin_watchYoutubeVideos = async pid=>
{
  console.log("ServerContext.fetchFromKaielvin_watchYoutubeVideos()");
  var fetched = await fetch("https://kaielvin.org/watchedYoutubeVideos/300");
  var json = await fetched.json();
  console.log("ServerContext.fetchFromKaielvin_watchYoutubeVideos()","json.length",json.length);
  var lastDate = 9999999999999;

  var uniqueVids = {};
  json = json.filter(({date,vid})=>
  {
    date = new Date(date);
    var delta = lastDate - date.valueOf();
    lastDate = date.valueOf();
    // if(delta < 15000) console.log(date,vid,"delta",Math.round(delta/100)/10+" sec");
    if(delta < 15000) return false;
    uniqueVids[vid] = true;
    return true;
  });

  console.log("ServerContext.fetchFromKaielvin_watchYoutubeVideos()","_.size(uniqueVids)",_.size(uniqueVids));



  // var videosWithDate = [];
  // // json = json.slice(0,50000);
  // json.forEach(({date,vid})=>
  // {
  //   var video = stridToNode(vid);
  //   if(!video) return; // adding only watchings of videos in the db in this version
  //   videosWithDate.push({video,date:new Date(date)});
  // });


  var videoPromisesWithDate = [];

  json = json.slice(0,100);
  for(var {date,vid} of json)
  // json.forEach(({date,vid})=>
  {
    date = new Date(date);
    // console.log(date.toGMTString(),vid);
    if(bannedFromYoutube) break;
    await makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.unlocked();
    // videosPromises.push(makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.process(vid));
    videoPromisesWithDate.push({promise:makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.process(vid),date});
  }
  // });

  var videosWithDate = [];
  for(var {promise,date} of videoPromisesWithDate)
    videosWithDate.push({video:await promise,date});

  videosWithDate = videosWithDate.filter(({video,date})=>
  {
    if(!video.error) return true;
    console.error("Failed loading video "+video.item,video.error);
    return false;
  }).map(({video,date})=>({video:video.node,date}));

  return videosWithDate;
}

console.log("NODE COUNT",_.size(_idToNodeIndex));


async function fetchOrGetCachedDbpediaJson(node)
{
  var fileName = node.strid.substring(4)+".json"
  var cachePath = './cache/dbpedia/'+fileName;
  if(!fs.existsSync(cachePath))
    await exec('cd ./cache/dbpedia/; wget "http://dbpedia.org/data/'+fileName+'"');
  return JSON.parse(await fss.readFile(cachePath));
}




var _treatPerson_lock;
var _treatPerson_counter = 0;
var givenNamesMap;
var surnamesMap;
var initNameMaps = ()=>
{
  if(!surnamesMap)
  {
    surnamesMap = {};
    $$('surname').$froms('object.instanceOf').forEach(n=>surnamesMap[n.$('object.title')] = n);
  }
  if(!givenNamesMap)
  {
    givenNamesMap = {};
    $$('givenName').$froms('object.instanceOf').forEach(n=>givenNamesMap[n.$('object.title')] = n);
  }
}
async function treatPerson(person,progress=undefined)
{
  if(person == _kaielvin) return;

  _treatPerson_counter++;
  if(_treatPerson_counter >= 50) _treatPerson_lock = Promises.resolvablePromise();

  // console.log("treatPerson()",_treatPerson_counter,person.name);

  // person.delete(); // killing everyone (but myself)

  try
  {
    var json = await fetchOrGetCachedDbpediaJson(person);
  }
  catch(e) {return;}
  // console.log("treatPerson()",_treatPerson_counter,person.name,"fetched");
  var resource = json['http://dbpedia.org/resource/'+person.strid.substring(4)];
  if(!resource) return _treatPerson_counter--; // ...
  var labels = resource['http://www.w3.org/2000/01/rdf-schema#label'];
  var labelEn = _.find(labels,label=>label.lang == 'en');
  if(!labelEn)
  {
    labels = resource['http://xmlns.com/foaf/0.1/name'];
    labelEn = _.find(labels,label=>label.lang == 'en');
  }
  // console.log(labelEn);
  // if(!labelEn) console.error(_.padEnd(person.strid,30), "No EN label");
  if(labelEn)
  {
    var label = labelEn.value;
    var braketMatch = label.match(/^([^(]+)(\(.*|)$/);
    label = _.trim(braketMatch[1]);
    label = label.replace(/,/g,'');
    var names = label.split(' ');
    // if(!(names.includes('van') || names.includes('Van'))) return _treatPerson_counter--;
    // if(!(names.includes('de') || names.includes('De')|| names.includes('Du')|| names.includes('du'))) return _treatPerson_counter--;
    // if(!names.slice(1,names.length-1).find(n=>_.lowerFirst(n)==n)) return _treatPerson_counter--;
    var data = {};
    do
    {
      data.givenName = names.shift();
      if(names.length == 0) break;
      var last = _.last(names);
      if(_.lowerCase(names) == 'jr')
      {
        data.suffix = 'Jr.';
        names.pop();
      }
      else if(_.lowerCase(last) == 'sr')
      {
        data.suffix = 'Sr.';
        names.pop();
      }
      else if(_.lowerCase(last).match(/^i+$/))
      {
        data.suffix = _.fill(Array(last.length), 'I').join('');
        names.pop();
      }
      if(names.length == 0) break;

      var prefixes = ['van','von','du','de','des','del','do','da','di','of','the','le','la','abu','ibn','bin','ben'];
      var prefixesAttached = ["d'",'al-'];
      var vanDeIndex = _.findIndex(names,n=>prefixes.includes(n.toLowerCase()) || prefixesAttached.some(pf=>n.toLowerCase().startsWith(pf)) );
      if(vanDeIndex >= 0)
      {
        data.surnamePrefix = names[vanDeIndex];
        data.surname = names.slice(vanDeIndex).join(' ');
        names = names.slice(0,vanDeIndex);
      }
      else
        data.surname = names.pop();

      if(names.length == 0) break;

      data.middleName = names[0];

    } while(false);

    // var givenName = Node.instanciate('givenName',['object.title',{s:data.givenName}]);
    // var personTitle = person.$('object.title');
    // if(!personTitle) person.$('object.title',{s:label});
    // var personGivenName = person.$('person.givenName');
    // if(!personGivenName) person.$('person.givenName',givenName);

    initNameMaps();

    // if(data.surname)
    // {
    //   var surname = surnamesMap[data.surname];
    //   if(!surname) surname = surnamesMap[data.surname] = Node.make().$('object.instanceOf','surname').$('object.title',{s:data.surname});
    //   // var surname = Node.instanciate('surname',['object.title',{s:data.surname}]);
    //   var personSurname = person.$('person.surname');
    //   if(!personSurname) person.$('person.surname',surname);
    // }
    if(data.middleName)
    {
      var personMiddleGivenName = person.$('person.middleGivenName');
      var personMiddleSurname = person.$('person.middleSurname');

      if(!(personMiddleGivenName || personMiddleSurname))
      {
        var givenName = givenNamesMap[data.middleName];
        var surname;
        if(!givenName)
        {
          if(_.lowerCase(data.middleName).length == 1) // 'L' or 'L.'
            givenName = givenNamesMap[data.middleName] = Node.make().$('object.instanceOf','givenName').$('object.title',{s:data.middleName});
          else
          {
            surname = surnamesMap[data.middleName];
            if(!surname) surname = surnamesMap[data.surname] = Node.make().$('object.instanceOf','surname').$('object.title',{s:data.middleName});
          }
        }

        if(givenName)    person.$('person.middleGivenName',givenName);
        else if(surname) person.$('person.middleSurname',surname);
      }
    }
    if(data.middleName)
      console.log(_.padEnd(label,40), _.padEnd(data.givenName,18), _.padEnd(data.middleName||'',18), _.padEnd(data.surname||'',18), _.padEnd(data.suffix||'',5),_.padStart(Math.round(progress*100)+'%',5));
  }
  _treatPerson_counter--;
  if(_treatPerson_lock)
  {
    _treatPerson_lock.resolve();
    _treatPerson_lock = undefined;
  }
}

async function findTextualMention(inNode,inField)
{
  var text = inNode.$(inField);
  if(!_.isString(text)) return;
  var splitter = /([ \!\@\#\$\%\^\&\*\)\(\+\=\.\<\>\{\}\[\]\:\;\"\|\~\`\_\,\—\–\±\−\÷×\×\≠\…\¡\¿\`\n\t]*)([^ \!\@\#\$\%\^\&\*\)\(\+\=\.\<\>\{\}\[\]\:\;\"\|\~\`\_\,\—\–\±\−\÷×\×\≠\…\¡\¿\`\n\t]+)/g;
  var pos = 0;
  var wordsPos = [...text.matchAll(splitter)].map(([full,separator,word])=>
  {
    pos+= full.length;
    return {word,pos:pos-word.length};
  });
  // var words = text.split(splitter);
  // console.log(text);
  // console.log(JSON.stringify([...text.matchAll(splitter)]));

  // ### searching for people ###
  initNameMaps();
  var foundGivenNames = wordsPos.map(({word,pos},i)=>givenNamesMap[word] ? ({word,pos,wordIndex:i}) : undefined).filter(o=>o);
  for(var {word,pos,wordIndex} of foundGivenNames)
  {
    var matches = [];
    var people = givenNamesMap[word].$froms('person.givenName');
    for(var person of people)
    {
      if(person.strid == 'dbr:Brain_(comics)') continue;
      if(person.strid == 'dbr:Cosmos') continue;
      if(person.strid == 'dbr:Julian_(emperor)') continue;
      if(person.strid == 'dbr:Steel_(John_Henry_Irons)') continue;
      if(person.strid == 'dbr:Melissa_(philosopher)') continue;
      if(person.strid == 'dbr:Scientist') continue;
      if(person.strid == 'dbr:Big_Bang') continue;
      if(person.strid == 'dbr:Crusher_(comics)') continue;
      if(person.strid == 'dbr:Hippo_(philosopher)') continue;
      if(person.strid == 'dbr:Lucy_(chimpanzee)') continue;
      if(person.strid == 'dbr:Yi_I') continue;
      if(person.strid == 'dbr:Joker_(comics)') continue;
      if(person.strid == 'dbr:Horace') continue;
      if(person.strid == 'dbr:Ismail_II') continue;
      if(person.strid == 'dbr:Rumi') continue;
      if(person.strid == 'dbr:Horus_(athlete)') continue;
      if(person.strid == 'dbr:Pandemic_(comics)') continue;
      if(person.strid == 'dbr:') continue;
      if(person.strid == 'dbr:') continue;
      if(person.strid == 'dbr:') continue;

      var surname = person.$('person.surname');
      surname = surname && surname.$('title');
      var middleName = person.$('person.middleGivenName') || person.$('person.middleSurname');
      middleName = middleName && middleName.$('title');
      if(!surname)
      {
        matches.push({person,pos,score:1});
        continue;
      }
      var nextWord = wordsPos[wordIndex+1];
      if(!nextWord) continue;
      nextWord = nextWord && nextWord.word;
      var nextNextWord = wordsPos[wordIndex+2];
      nextNextWord = nextNextWord && nextNextWord.word;

      var foundMiddleName = middleName && nextWord == middleName;
      var foundSurname1 = !foundMiddleName && surname && nextWord == surname;
      var foundSurname2 = nextNextWord && nextNextWord == surname;

      if(foundMiddleName && foundSurname2)
      {
        matches.push({person,pos,score:3});
        continue;
      }
      if(foundSurname1)
      {
        matches.push({person,pos,score: middleName ? 1 : 2 });
        continue;
      }

      // console.log(_.padEnd(str,18),_.padEnd(surname||'',18),title);
      // totalFound++;
    }
    if(matches.length > 0)
    {
      matches = _.sortBy(matches,match=>-match.score);
      var {person,pos,score} = matches[0];
      console.log(_.padEnd(person.$('title'),40),_.padEnd(score,3),_.padEnd(text,102),person.strid);
      var mention = Node.instanciate('textualMention',['in',inNode],['inField',inField],['of',person],['atCharacter',{n:pos}]);
      if(mention.$('score') != score) mention.$('score',{n:score});
    }
  }
}


if(true) (async ()=>
{
    garbageCollect();
    await recompactClaimsOnDisk();
    await importWatchings();

    // await importFromDBPedia();

    var totalFound = 0;
    if(false)
    // _.shuffle($$('YoutubeVideo').$froms('object.instanceOf')).forEach(video=>
    $$('YoutubeVideo').$froms('object.instanceOf').forEach(video=>
    {
      // if(totalFound >= 100) return;
      findTextualMention(video,$$('YoutubeVideo.title'));
      findTextualMention(video,$$('YoutubeVideo.description'));
      totalFound++;
    });


    return;

    var people = _.shuffle($$('person').$froms('object.instanceOf'));
    if(true)
    // for(var person of people)
    for(var i=0;i<people.length;i++)
    // for(var i=0;i<10;i++)
    {
      var person = people[i];
      while(_treatPerson_lock) await _treatPerson_lock;
      treatPerson(person,i/people.length);
    }

    return;



    // {
    //   if(person == _kaielvin) continue;

    //   // person.delete(); // killing everyone (but myself)

    //   var json = await fetchOrGetCachedDbpediaJson(person);
    //   var resource = json['http://dbpedia.org/resource/'+person.strid.substring(4)];
    //   var labels = resource['http://www.w3.org/2000/01/rdf-schema#label'];
    //   var labelEn = _.find(labels,label=>label.lang == 'en');
    //   // console.log(labelEn);
    //   if(!labelEn) console.error(_.padEnd(person.strid,30), "No EN label");
    //   else
    //   {
    //     var label = labelEn.value;
    //     var braketMatch = label.match(/^([^(]+)(\(.*|)$/);
    //     label = _.trim(braketMatch[1]);
    //     label = label.replace(/,/g,'');
    //     var names = label.split(' ');
    //     var data = {};
    //     do
    //     {
    //       data.givenName = names.shift();
    //       if(names.length == 0) break;
    //       data.surname = names.pop();
    //       if(names.length == 0) break;
    //       if(_.lowerCase(data.surname) == 'jr')
    //       {
    //         data.suffix = 'Jr';
    //         data.surname = names.pop();
    //       }
    //       if(_.lowerCase(data.surname).match(/^i+$/))
    //       {
    //         data.suffix = _.fill(Array(data.surname.length), 'I').join('');
    //         data.surname = names.pop();
    //       }

    //     } while(false);

    //     console.log(_.padEnd(person.strid,40), _.padEnd(label,37), _.padEnd(data.givenName,18), _.padEnd(data.surname||'',18), _.padEnd(data.suffix||'',5));
    //   }

    //   // var fileName = person.strid.substring(4)+".json"
    //   // var cacheFileName = './cache/dbpedia/'+fileName;
    //   // if(fs.existsSync(cacheFileName)) continue;
    //   // console.log(cacheFileName);

    //   // const { stdout, stderr } = await exec('cd ./cache/dbpedia/; wget "http://dbpedia.org/data/'+fileName+'"');
    //   // break;

    //   // var streamC2 = fs.createWriteStream(cacheFileName, {flags:'a',encoding: 'utf8'});
    //   // streamC2.write('.');
    //   // streamC2.close();
    //   // console.log("http://dbpedia.org/data/"+fileName);
    // }


    console.log('');
    console.log('');

    var youtubeVideos = $$('YoutubeVideo').$froms('object.instanceOf');
    console.log(youtubeVideos.length);
    if(false)
    for(var youtubeVideo of youtubeVideos)
    {
      var title = youtubeVideo.$('title');
      if(title.includes('Dan'))
        console.log(title);
    }


    // var count1 = Claim.count;
    // var count2 = [...Claim.makeOverallClaimIterator()].length;

    // var count1b = Claim.count;
    // var count2b = [...Claim.makeOverallClaimIterator()].length;

    // console.log(count1,count2,count1b,count2b);
  
})();


async function importWatchings()
{
  var _watching = $$('watching');
  var _watchingPerson = $$('watching.person');
  var _watchingVideo = $$('watching.video');
  var _watchingDate = $$('watching.date');

  (await ServerContext.fetchFromKaielvin_watchYoutubeVideos())
    .forEach(({video,date})=>
  {
    makeUnique([
      [_instanceOf,_watching],
      [_watchingPerson,_kaielvin],
      [_watchingVideo,video],
      [_watchingDate,{n:date.valueOf()}],
    ]);

    if(makeUnique.justCreated) console.log("start.js importWatchings added:",date.toGMTString(),video.$('prettyString'));
    // if(makeUnique.justCreated) console.log("start.js importWatchings created:",JSON.stringify([
    //   ['instanceOf','watching'],
    //   ['person','kaielvin'],
    //   ['video',video.strid],
    //   ['date',date.valueOf()],
    // ]));

    // makeUnique([
    //   [_instanceOf,'watching'],
    //   ['watching.person','kaielvin'],
    //   ['watching.video',video],
    //   ['watching.date',date.valueOf()],
    // ]);
    // $$()
    //   .$(_instanceOf,'watching')
    //   .$('person','kaielvin')
    //   .$('video',video)
    //   .$('date',date.valueOf());
  });
}

async function importFromDBPedia()
{

  const propertiesByPrefix = {
    dbc:['dct:subject'],
    dbo:['dct:type','rdf:type'],
    yago:['dct:type','rdf:type'],
    "umbel-rc":['dct:type','rdf:type'],
    dbr:['dbo:knownFor','dbo:mainInterest','dbp:occupation','dbo:field'],
  }

  var collectionsByCategory = {
    'philosopher':['dbr:Philosophy','dbo:Philosopher',
      'yago:Philosopher110423589',
      'dbc:Philosophers_of_science','dbr:Philosophers_of_cosmology'],
    'cosmologist':['dbr:Cosmology',
      'yago:Cosmologist109819667',
      'dbc:Cosmologists','dbc:Philosophy_of_astronomy','dbc:Physical_cosmology','dbr:Philosophers_of_cosmology'],
    'scientist':[
        'dbr:Science','dbr:Physicist','umbel-rc:Scientist',
      'yago:Scientist110560637',
      'yago:Physicist110428004',
      'dbo:Scientist',
      'dbc:Scientists'
    ],
    'psychologist':['dbr:Psychology'],
  };


  for(var category in collectionsByCategory)
  {
    console.log("CATEGORY",category);
    var collections = collectionsByCategory[category];
    for(var collection of collections)
    {
    console.log("  COLLECTION",collection);
      var prefix = collection.split(':')[0];
      var properties = propertiesByPrefix[prefix];
      for(var property of properties)
      {
        console.log("    PROPERTY",property);

        var query = `SELECT DISTINCT ?person WHERE {
                { ?person `+property+` `+collection+`. ?person rdf:type dbo:Person }
         } `;
        // var query = `SELECT DISTINCT ?person ?label WHERE {
        //         { ?person `+property+` `+collection+`. ?person foaf:name ?label. FILTER( lang(?label) = "en" ) }
        //  } `;
        // console.log('query:',query);
        query = encodeURI(query);

        var fetched = await fetch("http://dbpedia.org/sparql/?default-graph-uri=http%3A%2F%2Fdbpedia.org&query="+query+"&format=application%2Fsparql-results%2Bjson&CXML_redir_for_subjs=121&CXML_redir_for_hrefs=&timeout=30000&debug=on&run=+Run+Query+");
        try
        {
          var json = await fetched.json();
        }
        catch(e)
        {
          console.error("Response not json",e);
          return;
        }
        // console.log(json);
        // console.log(json.results);
        // console.log(json.results.bindings);
        // json.results.bindings.forEach(o=>console.log(o.person.value));
        var dbpediaUrls = json.results.bindings.map(o=>o.person.value);
        dbpediaUrls.forEach(dbpediaUrl=>
        {
          var strid = "dbr:"+_.last(dbpediaUrl.split('/'));
          console.log("      + "+strid);
          var node = Node.getByStrid(strid);
          if(node) return; // created already
          node = Node.makeByStrid(strid)
            .$(_instanceOf,"person")
            .$('occupations','occupation:'+category);

        });
        console.log("    PROPERTY",property,'count',json.results.bindings.length);
      }
    }
  }


}









//   // async function fetchYoutubePlaylistPages(playlistId,pages=[],pageToken=undefined)
//   // {
//   //   var url = 'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&key=AIzaSyAL23rZogdOZasdGcPD92_7Gxy4hkvMlZE&playlistId='+playlistId+'&maxResults=50';
//   //   if(pageToken) url+= '&pageToken='+pageToken;
//   //   console.log("fetchYoutubePlaylistPages()",'fetching',url);
//   //   var fetched = await fetch(url);
//   //   var json = await fetched.json();
//   //   pages.push(json);
//   //   if(json.nextPageToken) await fetchYoutubePlaylist(playlistId,pages,json.nextPageToken);
//   //   return pages;
//   // }
//   // // TODO expire cache past a certain date
//   // async function getYoutubePlaylistPages(playlistId)
//   // {
//   //   var cachePath = './cache/youtube_playlist/'+playlistId+'.json';
//   //   if(fs.existsSync(cachePath)) return JSON.parse(await fss.readFile(cachePath));
//   //   var cached = {};
//   //   cached.pages = await fetchYoutubePlaylistPages(playlistId);
//   //   cached.requestedAt = new Date();
//   //   await fss.writeFile(cachePath,JSON.stringify(cached),'utf8');
//   //   return cached;
//   // }

//   // // makeYouTubeVideoFromPlaylistDataAndByFetching = async item=>
//   // // {
//   // //   var video = await $$('YoutubeVideo','instanciable.make')(item.snippet.resourceId.videoId,false);

//   // //   $$('YoutubeThumbnailResolution').$froms('instanceOf').forEach(resolution=>
//   // //   {
//   // //     // console.log("resolution",resolution.name,$$(resolution,'stringName'));
//   // //     if(item.snippet.thumbnails[$$(resolution,'stringName')])
//   // //       video.$('thumbnailResolutions',resolution);
//   // //   });
//   // //   return video;
//   // // }

//   // // var makeYouTubeVideoFromPlaylistDataAndByFetching_Pool = new Promises.WorkerPool(25)
//   // //   .setWorker(makeYouTubeVideoFromPlaylistDataAndByFetching);



//   // // ServerContext.cachedFetch_YoutubePlaylistVideos = async pid=>
//   // // {
//   // //   var videos = [];
//   // //   var json = await getYoutubePlaylistPages(pid);
//   // //   if(!json.pages) return [];

//   // //   var videosPromises = [];
//   // //   for(var p in json.pages)
//   // //     for(var i in json.pages[p].items)
//   // //     {
//   // //       var item = json.pages[p].items[i];
//   // //       await makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.unlocked();
//   // //       videosPromises.push(makeYouTubeVideoFromPlaylistDataAndByFetching_Pool.process(item));

//   // //       // console.log("cachedFetch_YoutubePlaylistVideos() DONE ",video.$('title'));

//   // //       // var video = await $$('YoutubeVideo','instanciable.make')(item.snippet.resourceId.videoId,true);
//   // //       // video.$('title',{s:item.snippet.title});
//   // //       // video.$('description',{s:item.snippet.description});

//   // //       // var video = await $$('YoutubeVideo','instanciable.make')(item.snippet.resourceId.videoId,false);

//   // //       // $$('YoutubeThumbnailResolution').$froms('instanceOf').forEach(resolution=>
//   // //       // {
//   // //       //   console.log("resolution",resolution.name,$$(resolution,'stringName'));
//   // //       //   if(item.snippet.thumbnails[$$(resolution,'stringName')])
//   // //       //     video.$('thumbnailResolutions',resolution);
//   // //       // });
//   // //       // videos.push(video);
//   // //     }
      
//   // //   var videos = Promise.all(videosPromises);
//   // //   return videos;
//   // // }




//   // ServerContext.cachedFetch_YoutubeVideo = async vid=>
//   // {
//   //   var cachePath = './cache/youtube_video/'+vid+'.json';
//   //   if(fs.existsSync(cachePath)) return JSON.parse(await fss.readFile(cachePath));
//   //   var url = 'https://www.googleapis.com/youtube/v3/videos?id='+vid+'&key=AIzaSyAL23rZogdOZasdGcPD92_7Gxy4hkvMlZE&part=snippet,contentDetails,statistics,status';
//   //   console.log("ServerContext.cachedFetch_YoutubeVideo()",'fetching',url);
//   //   var fetched = await fetch(url);
//   //   var json = await fetched.json();
//   //   if(json.error) return undefined;
//   //   json.requestedAt = new Date();
//   //   await fss.writeFile(cachePath,JSON.stringify(json),'utf8');
//   //   return json;
//   // }





//   (async ()=>
//   {

//     await wait(500);
//     console.log("MAKING");
//     // $$('YoutubeVideo','instanciable.make')('Lhv_yFMuwxs');
//     // $$('YoutubeVideo','instanciable.make')('nnVq6gmatHU');
//     // $$('YoutubeVideo','instanciable.make')('Qw4l1w0rkjs');
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQs9dl3butrQDN0mqZJyG95'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'existence')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQSeOwjFgky9RRBGWpY-5xNh'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'morality')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQTBfsRCrrr6vGOjFDQSgRpJ'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'self-improvement')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQL8Z07uB8XUSeSkeW_EG66'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'consciousness')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQS14MaRPjRdYM_Y-HwoQFPJ'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'psychology')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQuJC8vK0iDB_Gsrbldwj_A'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'society')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQ6TV2go-XCcB4n3s7bWj6q'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'neuroscience')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQy4UXMPHp9tw7OUidxiKeB'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'philosophy-of-mind')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQVeEl1C6SuYtIUE-caAqG0'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'social')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQRLIQuriccuibNULk_RNvSu'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'technology')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQQbNvrSfhcS9L1h9sjj-k4Q'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'hegel')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQS9Rq-ZWd00czLSWdbhjfr6'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'art&design')) );
//     (await ServerContext.cachedFetch_YoutubePlaylistVideos('PLfoEg9YVcQQRPDlWPVHjc-ALoZvzjeH3s'))
//       .forEach(video=> video.$('tags',KaiElvin.$froms('tag.createdBy').find(u=>u.$('title') == 'to-rewatch')) );

//     await wait(50);
//     console.log("filling KaiWatchingList");

//     $$('YoutubeVideo').$froms('instanceOf').forEach(video=>
//       $$(video,'tags','KaiWatchingList') );

//     // $$('YoutubeVideo').$from('instanceOf').forEach(video=>
//     //   $$('KaiWatchingList').$('items',video) );

//   })()





//   // https://www.youtube.com/oembed?format=json&amp;url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DnnVq6gmatHU
//   // https://www.googleapis.com/youtube/v3/videos?id=nnVq6gmatHU&key=AIzaSyByA7cXJD_3Hi8f2rTQ3loCyqIA6NfK9fc&part=snippet,contentDetails,statistics,status
//   //https://www.youtube.com/embed/HIbAz29L-FA?modestbranding=1&playsinline=0&showinfo=0&enablejsapi=1&origin=https%3A%2F%2Fintercoin.org&widgetid=1
//   // var url = new URL('https://www.youtube.com/watch?v=PZozMO3wWf&l=01234567');
//   // console.log(url,url.searchParams.keys(),url.searchParams.get('v'));
//   // for (let p of url.searchParams) {
//   //   console.log(p);
//   // }









