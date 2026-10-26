const assert = require('node:assert/strict')
const path = require('node:path')

module.exports = async ({chromium,executablePath,baseUrl,screenshotDir}) => {
  const browser = await chromium.launch({headless:true,executablePath})
  const page = await browser.newPage({viewport:{width:1380,height:900},timezoneId:'America/Los_Angeles'})
  const errors=[],screenshots=[]
  page.on('pageerror',error=>errors.push(error.message))
  page.setDefaultTimeout(12000)
  await page.addInitScript(()=>{
    const clone=value=>JSON.parse(JSON.stringify(value))
    const listeners=new Set()
    const run={runId:'fixture-run',status:'running',phase:'normalizing',startedAt:'2026-10-17T00:00:00Z',model:'fixture-model',totalBooks:7776,concurrency:1000,cachedBooks:100,savedBooks:30,failedBooks:30,missingBooks:0}
    const batches=Array.from({length:1000},(_,index)=>({runId:'fixture-run',batchId:`normalize-${index+1}`,requestId:index+1,phase:'normalizing',batchIndex:index+1,batchTotal:1000,bookCount:30,pairCount:0,status:'queued',members:[{id:`book-${index}`,title:`测试作品 ${index+1}`}],savedCount:0}))
    Object.assign(batches[0],{status:'receiving',startedAt:'2026-10-17T00:00:00Z',stream:true,timeoutMs:60000,timeoutMode:'stream_idle',attempts:[{attempt:1,status:'receiving',streamBytes:1500000,contentBytes:40000,reasoningBytes:64,endpoint:'http://fixture.invalid/v1/chat/completions',startedAt:'2026-10-17T00:00:00Z',firstByteAt:'2026-10-17T00:00:02Z',firstContentAt:'2026-10-17T00:00:03Z',lastByteAt:'2026-10-17T00:00:42Z',usage:null}]})
    Object.assign(batches[1],{status:'failed',errorCode:'AI_RESPONSE_TOO_LARGE',failedCount:30,attempts:[{attempt:1,status:'failed',complete:false,httpStatus:503,streamBytes:32,contentBytes:0,usage:null},{attempt:2,status:'failed',complete:false,httpStatus:200,streamBytes:33554433,contentBytes:12000,limitKind:'stream',limitBytes:33554432,receivedBytes:33554433,usage:null}]})
    Object.assign(batches[2],{status:'recovered',returnedCount:30,savedCount:29,recoverySavedCount:1,effectiveSavedCount:30,unresolvedCount:0,failedCount:1,errorCode:'AI_RESULT_INVALID',errorDetail:{reason:'EVIDENCE_MISMATCH',path:'books[2].evidenceRefs[0].quote'}})
    Object.assign(batches[3],{status:'failed',errorCode:'AI_RESPONSE_TRUNCATED',reasoningProtocol:'deepseek',thinkingMode:'disabled',maxOutputTokens:32768,outputTokenField:'max_tokens',recoveryOf:'normalize-parent',recoverySizes:[15,15],truncationReason:'length',attempts:[{attempt:1,status:'failed',complete:false,httpStatus:200,finishReason:'length',truncationReason:'length',usage:{prompt_tokens:3875,completion_tokens:16383,total_tokens:20258,completion_tokens_details:{reasoning_tokens:14721}}}]})
    Object.assign(batches[1].attempts[0],{outputTps:12.5,tpsDurationMs:400,usage:{completion_tokens:5}})
    Object.assign(batches[2],{attempts:[{attempt:1,status:'completed',complete:true,outputTps:0,tpsDurationMs:1000,usage:{completion_tokens:0}}]})
    Object.assign(batches[3].attempts[0],{outputTps:223.5,tpsDurationMs:73302,completedAt:'2026-10-17T00:01:13Z'})
    let seq=10,body='{"books":[{"id":"book-0","workTitle":"测试作品"}],"preview":"'+ '模拟流式正文'.repeat(15000)
    window.fixtureTrace={batches,reads:[],copied:'',exports:[],append(){body+='新增流式内容';batches[0].attempts[0].contentBytes+=18;listeners.forEach(listener=>listener([{seq:++seq,at:'2026-10-17T08:01:00+08:00',event:'receiving',runId:'fixture-run',batch:clone(batches[0])}]))},burst(){
      const updates=batches.map((batch,index)=>{if(index>3)batch.status='requesting';return{seq:++seq,at:'2026-10-17T08:01:00+08:00',event:'receiving',runId:'fixture-run',batch:clone(batch)}})
      listeners.forEach(listener=>listener(updates))
    }}
    window.aiTraceApi={
      bootstrap:async()=>({setting:{language:'zh-CN',theme:'dark'},selection:{runId:'fixture-run',batchId:'normalize-1'}}),
      snapshot:async()=>clone({seq,runId:'fixture-run',runs:[run],run,batches,events:[]}),
      onEvents:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},onSelect:()=>()=>{},
      readText:async request=>{
        window.fixtureTrace.reads.push(request)
        const source=request.kind==='messages'?JSON.stringify({model:'fixture-model',stream:true,messages:[{role:'system',content:'按原始资料解析每本作品'},{role:'user',content:'测试作品'}]},null,2):request.kind==='content'?body:request.kind==='sse'?'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n':request.kind==='reasoning'?'上游实际返回的公开思考字段':request.kind==='parsed'?'{"books":[{"id":"book-0"}]}':'{"status":"failed","errorDetail":{"reason":"EVIDENCE_MISMATCH","path":"books[0].evidenceRefs[0].quote"}}'
        const bytes=new TextEncoder().encode(source),start=request.offset||0
        let end=Math.min(start+(request.limit||65536),bytes.length)
        while(end<bytes.length&&(bytes[end]&0xc0)===0x80)end++
        return {text:new TextDecoder().decode(bytes.slice(start,end)),nextOffset:end,totalBytes:bytes.length,hasMore:end<bytes.length}
      },
      export:async request=>{window.fixtureTrace.exports.push(request);return{ok:true}}
    }
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{window.fixtureTrace.copied=value}}})
  })
  try {
    await page.goto(baseUrl+'/ai-inspector.html',{waitUntil:'domcontentloaded',timeout:30000})
    await page.getByRole('heading',{name:'AI 请求详情'}).waitFor()
    await page.locator('.raw-viewer').waitFor()
    assert.match(await page.locator('.request-tps').innerText(),/平均 TPS 待统计/)
    assert.match(await page.locator('.el-table__body-wrapper tbody tr').first().innerText(),/平均 TPS 待统计/)
    assert.match(await page.locator('.raw-viewer').inputValue(),/按原始资料解析/)
    assert.equal(await page.locator('.el-table__body-wrapper tbody tr').count(),40,'Only a page of 1000 batch records is rendered')
    await page.getByRole('tab',{name:'元信息',exact:true}).click()
    await page.getByText('2026-10-17 08:00:02',{exact:true}).waitFor()
    assert.match(await page.locator('.metadata').innerText(),/未知/)
    assert.match(await page.locator('.metadata').innerText(),/1\.43 MiB/)
    await page.getByRole('tab',{name:'流式原文',exact:true}).click()
    await page.waitForFunction(()=>document.querySelector('.raw-viewer')?.value.includes('模拟流式正文'))
    await page.getByRole('button',{name:'加载更多',exact:true}).click()
    const firstLength=(await page.locator('.raw-viewer').inputValue()).length
    await page.locator('.el-checkbox').filter({hasText:'实时跟随'}).click()
    const readCount=await page.evaluate(()=>window.fixtureTrace.reads.length)
    await page.evaluate(()=>window.fixtureTrace.append())
    await page.waitForTimeout(1100)
    assert.equal(await page.evaluate(()=>window.fixtureTrace.reads.length),readCount)
    assert.equal((await page.locator('.raw-viewer').inputValue()).length,firstLength)
    await page.getByRole('button',{name:'复制预览',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.fixtureTrace.copied.length),firstLength)
    await page.getByRole('button',{name:'导出完整原文',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.fixtureTrace.exports[0].kind),'content')
    const readsBeforeBurst=await page.evaluate(()=>window.fixtureTrace.reads.length)
    await page.evaluate(()=>window.fixtureTrace.burst())
    assert.equal(await page.locator('.el-table__body-wrapper tbody tr').count(),40)
    assert.equal(await page.evaluate(()=>window.fixtureTrace.reads.length),readsBeforeBurst,'Bulk progress updates do not load other requests raw text')
    await page.locator('.el-radio-button').filter({hasText:'SSE'}).click()
    await page.waitForFunction(()=>document.querySelector('.raw-viewer')?.value.startsWith('data:'))
    await page.getByRole('tab',{name:'解析结果',exact:true}).click()
    await page.locator('.el-radio-button').filter({hasText:'业务校验'}).click()
    await page.waitForFunction(()=>document.querySelector('.raw-viewer')?.value.includes('EVIDENCE_MISMATCH'))
    await page.locator('.batch-filters .el-select').click()
    await page.getByRole('option',{name:'已完成',exact:true}).click()
    assert.equal(await page.locator('.el-table__body-wrapper tbody tr').count(),1)
    await page.locator('.el-table__body-wrapper tbody tr').first().click()
    assert.match(await page.locator('.detail-heading').innerText(),/已恢复/)
    assert.match(await page.locator('.request-detail').innerText(),/补试保存 1 · 仍未解决 0/)
    assert.match(await page.locator('.request-detail').innerText(),/首次请求错误（已恢复）/)
    assert.equal(await page.locator('.request-error').count(),0,'Recovered request retains its historical error as a note')
    assert.match(await page.locator('.request-tps').innerText(),/0\.00 tokens\/s/)
    const recoveredFile=path.join(screenshotDir,'ai-inspector-recovered.png')
    await page.screenshot({path:recoveredFile,animations:'disabled'});screenshots.push(recoveredFile)
    await page.locator('.batch-filters .el-select').click()
    await page.getByRole('option',{name:'失败 / 未完成',exact:true}).click()
    assert.equal(await page.locator('.el-table__body-wrapper tbody tr').count(),2)
    await page.locator('.el-table__body-wrapper tbody tr').filter({hasText:'#4/1000'}).click()
    await page.getByText('上游输出长度耗尽；该响应未形成完整结果。',{exact:true}).waitFor()
    await page.getByText('已请求关闭思考，但上游仍返回了思考内容或用量；关闭参数未获得预期效果。',{exact:true}).waitFor()
    await page.getByRole('tab',{name:'元信息',exact:true}).click()
    assert.match(await page.locator('.metadata').innerText(),/14721/)
    assert.match(await page.locator('.metadata').innerText(),/32768/)
    assert.match(await page.locator('.metadata').innerText(),/length/)
    assert.match(await page.locator('.request-tps').innerText(),/223\.50 tokens\/s/)
    assert.match(await page.locator('.metadata').innerText(),/73302 ms/)
    assert.match(await page.locator('.request-tps').innerText(),/含思考与首包等待/)
    const truncationFile=path.join(screenshotDir,'ai-inspector-truncation.png')
    await page.screenshot({path:truncationFile,animations:'disabled'});screenshots.push(truncationFile)
    await page.locator('.el-table__body-wrapper tbody tr').first().click()
    await page.getByText('客户端大小限制',{exact:false}).waitFor()
    assert.match(await page.locator('.request-note').innerText(),/未完整结束/)
    await page.getByRole('tab',{name:'元信息',exact:true}).click()
    assert.match(await page.locator('.metadata').innerText(),/未知/)
    assert.match(await page.locator('.request-tps').innerText(),/平均 TPS 未知/)
    await page.locator('.detail-heading .el-select').click()
    await page.getByRole('option',{name:'尝试 1 · HTTP 503',exact:true}).click()
    assert.match(await page.locator('.request-tps').innerText(),/12\.50 tokens\/s/)
    await page.locator('.detail-heading .el-select').click()
    await page.getByRole('option',{name:'尝试 2 · HTTP 200',exact:true}).click()
    assert.match(await page.locator('.request-tps').innerText(),/平均 TPS 未知/)
    for(const width of [1380,900]){
      await page.setViewportSize({width,height:900})
      await page.waitForTimeout(100)
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      const file=path.join(screenshotDir,`ai-inspector-${width}.png`)
      await page.screenshot({path:file,animations:'disabled'});screenshots.push(file)
    }
    await page.reload()
    await page.waitForFunction(()=>document.querySelector('.raw-viewer')?.value.includes('按原始资料解析'))
    assert.deepEqual(errors,[])
    return {screenshots,checks:'1000 batches paginated, Beijing time, independent result and stream sizes, four detail tabs, missing usage, pause, copy, export, attempts, failure raw and reload'}
  } catch(error){await page.screenshot({path:path.join(screenshotDir,'ai-inspector-failure.png')});throw error}
  finally{await browser.close()}
}
