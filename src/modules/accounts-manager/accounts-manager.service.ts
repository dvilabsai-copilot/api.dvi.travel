// FILE: src/modules/accounts-manager/accounts-manager.service.ts

import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma.service";
import {
  AccountsManagerQueryDto,
  AccountsManagerStatus,
  AccountsManagerComponentType,
} from "./dto/accounts-manager-query.dto";
import {
  AccountsManagerRowDto,
  AccountsManagerRowComponentType,
} from "./dto/accounts-manager-row.dto";
import {
  AccountsManagerSummaryDto,
  AccountsManagerQuoteDto,
  AccountsManagerAgentDto,
  AccountsManagerPaymentModeDto,
  AccountsManagerPayDto,
} from "./dto/accounts-manager-extra.dto";

@Injectable()
export class AccountsManagerService {
  constructor(private readonly prisma: PrismaService) {}

 // MAIN LIST now also exposes headerId, routeDate, vendorId, vehicleId

  // DVI_LOCAL_VERIFIED_HOTEL_REPAIR_V2
  // Explicit finance-reviewed, exact-booking recovery. No changes to other components.
  // Do not use a selling quote as proof of a supplier liability or payment history.

  // DVI_HOTEL_COMMON_REVIEW_V4: explicit Finance review, no writes on reads.

  // DVI_HOTEL_AUTO_FINANCE_V5: source-matched supplier stays; explicit batch/contract approval.

  // DVI_HOTEL_AUTO_PURCHASE_V7: stored supplier components, never manually entered rates.
  private autoStoredHotelPurchase(row:any) {
    const baseFields=['total_room_cost','total_hotel_meal_plan_cost','total_extra_bed_cost','total_childwith_bed_cost','total_childwithout_bed_cost','total_amenities_cost'];
    const taxFields=['total_room_gst_amount','total_hotel_meal_plan_cost_gst_amount','total_extra_bed_cost_gst_amount','total_childwith_bed_cost_gst_amount','total_childwithout_bed_cost_gst_amount','total_amenities_gst_amount'];
    const bases=baseFields.map(k=>this.autoHotelCents(row[k])), taxes=taxFields.map(k=>this.autoHotelCents(row[k]));
    const sell=this.autoHotelCents(row.total_hotel_cost),tax=this.autoHotelCents(row.total_hotel_tax_amount),margin=this.autoHotelCents(row.hotel_margin_rate),marginTax=this.autoHotelCents(row.hotel_margin_rate_tax_amt);
    if([...bases,...taxes,sell,tax,margin,marginTax].some(x=>x===null))return null;
    const base=(bases as number[]).reduce((a,b)=>a+b,0),purchaseTax=(taxes as number[]).reduce((a,b)=>a+b,0);
    if(!Number.isSafeInteger(base+purchaseTax)||base+purchaseTax<=0)return null;
    // Older imports may store net totals with the margin separately. Only accept exact reconciliation, never clamp a negative tax.
    const grossMatches=sell===base+margin!&&tax===purchaseTax+marginTax!;
    const netMatches=sell===base&&tax===purchaseTax;
    if(!grossMatches&&!netMatches)return null;
    return {sell:sell!,tax:tax!,base,purchaseTax,payable:base+purchaseTax,margin,marginTax,bases,taxes,layout:grossMatches?'selling':'legacy-net'};
  }
  private async autoStoredOfflineGroups(tx:any,p:any,headerId:number,rows:any[],drafts:any[],prior:any[],vouchers:any[],providers:any[]) {
    const result:any={groups:[],reasons:[]};
    const planId=Number(p.itinerary_plan_ID),confirmedId=Number(p.confirmed_itinerary_plan_ID);
    const fail=(m:string)=>result.reasons.push(m);
    for(const r of rows){
      const provider=this.autoHotelProvider(r.hotel_provider),code=String(r.hotel_code||'').trim();
      if(provider!==''&&provider!=='offline')continue;
      const id=Number(r.confirmed_itinerary_plan_hotel_details_ID),originalId=Number(r.itinerary_plan_hotel_details_ID),route=Number(r.itinerary_route_id),date=this.autoHotelDay(r.itinerary_route_date);
      if(prior.some(f=>f.cnf_itinerary_plan_hotel_details_ID===id||f.itinerary_plan_hotel_details_ID===originalId||f.itinerary_route_id===route))continue;
      const o=drafts.find(x=>x.itinerary_plan_hotel_details_ID===originalId);
      if(!id||!originalId||!route||!date||![0,1].includes(r.status)||r.deleted!==0||r.hotel_required!==1||r.hotel_cancellation_status!==0||!o||o.deleted!==0||o.status!==1||o.hotel_required!==1||o.hotel_cancellation_status!==0||o.itinerary_route_id!==route||this.autoHotelDay(o.itinerary_route_date)!==date||rows.filter(x=>x.itinerary_route_id===route).length!==1||providers.some(x=>x.route===route)||this.autoHotelProvider(o.hotel_provider)!==provider||String(o.hotel_code||'').trim()!==code||r.requires_price_reacceptance||o.requires_price_reacceptance){fail('offline stay identity, status or route not verified');continue;}
      const hotelId=await this.hotelReviewIdentity(tx,r);
      if(!hotelId||hotelId!==Number(r.hotel_id)||hotelId!==Number(o.hotel_id)||await this.hotelReviewIdentity(tx,o)!==hotelId||!Number.isSafeInteger(Number(r.total_no_of_rooms))||Number(r.total_no_of_rooms)<=0||Number(o.total_no_of_rooms)!==Number(r.total_no_of_rooms)){fail('offline hotel identity or rooms not verified');continue;}
      const related=vouchers.filter(v=>v.itinerary_plan_hotel_details_ID===originalId||v.confirmed_itinerary_plan_hotel_details_ID===id);
      if(related.some(v=>v.hotel_voucher_cancellation_status===1||v.hotel_booking_status===2||v.status===1&&v.deleted===0&&(v.hotel_booking_status!==1||v.hotel_id!==hotelId||v.itinerary_plan_id!==planId||v.itinerary_plan_hotel_details_ID!==originalId||v.confirmed_itinerary_plan_hotel_details_ID!==id||this.autoHotelDay(v.itinerary_route_date)!==date))){fail('offline voucher cancelled, pending or conflicting');continue;}
      const activeVouchers=related.filter(v=>v.status===1&&v.deleted===0&&v.hotel_booking_status===1);
      if(activeVouchers.length>1){fail('multiple active offline vouchers');continue;}
      const approved=(x:any)=>String(x.hotel_approval_status||'').toUpperCase()==='APPROVED'&&String(x.manual_confirmation_status||'').toUpperCase()==='CONFIRMED'&&Number(x.manually_confirmed_by)>0&&!!this.autoHotelDay(x.manually_confirmed_at);
      const hasVoucher=activeVouchers.length===1&&!!String(activeVouchers[0].hotel_confirmed_reservation||'').trim()&&!!String(activeVouchers[0].hotel_confirmation_verified_by||'').trim();
      const currencyR=String(r.selected_currency||'').trim().toUpperCase(),currencyO=String(o.selected_currency||'').trim().toUpperCase();
      if((currencyR&&currencyR!=='INR')||(currencyO&&currencyO!=='INR')){fail('offline non-INR pricing');continue;}
      const cost=this.autoStoredHotelPurchase(r),originalCost=this.autoStoredHotelPurchase(o);
      if(!cost||!originalCost||JSON.stringify(cost)!==JSON.stringify(originalCost)){fail('offline stored purchase components do not reconcile');continue;}
      const confirmedEvidence=approved(r)&&approved(o)||hasVoucher;
      if(!confirmedEvidence&&(provider==='offline'||code||String(r.hotel_booking_mode||'').toUpperCase()==='MANUAL_APPROVAL'||String(o.hotel_booking_mode||'').toUpperCase()==='MANUAL_APPROVAL')){fail('offline booking still needs its normal supplier confirmation');continue;}
      // Without a verified booking record, this is a historical review candidate only, NOT evidence of a real liability.
      // Legacy candidates are always gated by an explicit batch hash, even if their date is after the new-booking cutoff.
      const kind=confirmedEvidence&&currencyR==='INR'&&currencyO==='INR'?'offline':'legacy-offline';
      if(kind==='legacy-offline'&&(String(r.hotel_approval_status||'').toUpperCase()==='REJECTED'||String(o.hotel_approval_status||'').toUpperCase()==='REJECTED')){fail('offline approval rejected');continue;}
      const next=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
      result.groups.push({planId,confirmedId,headerId,quote:String(p.itinerary_quote_ID||''),hotelId,provider:kind,reference:'internal-row:'+id,checkIn:date,checkOut:next,supplierTotal:cost.payable,confirmedAt:p.createdon?new Date(p.createdon).toISOString():'',allocations:[{id,originalId,route,date,sell:cost.sell,tax:cost.tax,base:cost.base,purchaseTax:cost.purchaseTax,payable:cost.payable}],evidence:confirmedEvidence?'recorded-offline-confirmation':'requires-Finance-batch-verification',priceLayout:cost.layout});
    }
    return result;
  }


  // DVI_HOTEL_DIRECT_PURCHASE_V8: explicitly isolated local test database only.

  // DVI_HOTEL_SAVED_PRICE_V9: correct only the known unpaid V4 sample; never overwrite other finance.
  private async correctHotelSamplePricesV9():Promise<string> {
    if(!this.hotelSavedPriceTestMode()||process.env.DVI_HOTEL_TEST_CORRECT_SAMPLE!=='yes')return 'sample correction disabled';
    return this.prisma.$transaction(async(tx:any)=>{
      const quote='DVI20260963-R2',planId=10324,confirmedId=209,headerId=203,hotelId=150;
      const ids=[1212,1213,1214],originalIds=[18900,18904,18908],routes=[11863,11864,11866],dates=['2026-09-20','2026-09-21','2026-09-23'];
      const plans=await tx.dvi_confirmed_itinerary_plan_details.findMany({where:{OR:[{itinerary_plan_ID:planId},{itinerary_quote_ID:quote}],status:1,deleted:0}});
      const originalPlans=await tx.dvi_itinerary_plan_details.findMany({where:{itinerary_plan_ID:planId,quotation_status:1,deleted:0}});
      const headers=await tx.dvi_accounts_itinerary_details.findMany({where:{OR:[{itinerary_plan_ID:planId},{confirmed_itinerary_plan_ID:confirmedId}]}});
      if(plans.length!==1||plans[0].confirmed_itinerary_plan_ID!==confirmedId||plans[0].itinerary_plan_ID!==planId||plans[0].itinerary_quote_ID!==quote||originalPlans.length!==1||originalPlans[0].itinerary_quote_ID!==quote||headers.length!==1||headers[0].accounts_itinerary_details_ID!==headerId||headers[0].itinerary_plan_ID!==planId||headers[0].confirmed_itinerary_plan_ID!==confirmedId||headers[0].deleted!==0||headers[0].status!==1)return 'sample booking identity mismatch';
      const [stays,drafts,finance,history,vouchers]=await Promise.all([
        tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,deleted:0}}),
        tx.dvi_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,itinerary_plan_hotel_details_ID:{in:originalIds}}}),
        tx.dvi_accounts_itinerary_hotel_details.findMany({where:{OR:[{accounts_itinerary_details_ID:headerId},{itinerary_plan_ID:planId},{cnf_itinerary_plan_hotel_details_ID:{in:ids}}]}}),
        tx.dvi_accounts_itinerary_hotel_transaction_history.findMany({where:{accounts_itinerary_details_ID:headerId}}),
        tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({where:{itinerary_plan_id:planId}})
      ]);
      if(history.length||vouchers.length||stays.length!==3||drafts.length!==3||finance.length!==3)return 'sample history or row count differs; no correction';
      const rowIds=finance.map((f:any)=>f.accounts_itinerary_hotel_details_ID);
      if((await tx.dvi_accounts_itinerary_hotel_transaction_history.findMany({where:{accounts_itinerary_hotel_details_ID:{in:rowIds}}})).length)return 'sample has payment history; no correction';
      const resolved:any[]=[];
      for(let i=0;i<ids.length;i++){
        const matches=finance.filter((f:any)=>f.cnf_itinerary_plan_hotel_details_ID===ids[i]);
        const f=matches[0],r=stays.find((x:any)=>x.confirmed_itinerary_plan_hotel_details_ID===ids[i]),o=drafts.find((x:any)=>x.itinerary_plan_hotel_details_ID===originalIds[i]);
        if(matches.length!==1||!r||!o||f.accounts_itinerary_details_ID!==headerId||f.itinerary_plan_ID!==planId||f.hotel_id!==hotelId||f.itinerary_plan_hotel_details_ID!==originalIds[i]||f.itinerary_route_id!==routes[i]||this.autoHotelDay(f.itinerary_route_date)!==dates[i]||f.status!==1||f.deleted!==0||this.autoHotelCents(f.total_paid)!==0||this.autoHotelCents(f.total_payable)===null||this.autoHotelCents(f.total_balance)!==this.autoHotelCents(f.total_payable))return 'sample finance identity or paid amount changed';
        if(r.itinerary_plan_hotel_details_ID!==originalIds[i]||![0,1].includes(r.status)||o.status!==1||[r,o].some(x=>x.deleted!==0||x.hotel_required!==1||x.hotel_cancellation_status!==0||x.hotel_id!==hotelId||x.itinerary_route_id!==routes[i]||this.autoHotelDay(x.itinerary_route_date)!==dates[i]||this.autoHotelCents(x.total_hotel_cost)!==100000||this.autoHotelCents(x.total_hotel_tax_amount)!==0||x.requires_price_reacceptance))return 'sample saved prices or hotel assignment changed';
        if(await this.hotelReviewIdentity(tx,r)!==hotelId||await this.hotelReviewIdentity(tx,o)!==hotelId)return 'sample hotel master mismatch';
        resolved.push(f);
      }
      const values=resolved.map(f=>this.autoHotelCents(f.total_payable));
      if(values.every(v=>v===100000))return 'sample already corrected';
      if(Number(values[0])+Number(values[1])!==6688800||values[2]!==13400)return 'sample amounts do not match known incorrect test values';
      for(const f of resolved){const changed=await tx.dvi_accounts_itinerary_hotel_details.updateMany({where:{accounts_itinerary_hotel_details_ID:f.accounts_itinerary_hotel_details_ID,total_paid:0,total_payable:f.total_payable,total_balance:f.total_balance,status:1,deleted:0},data:{total_hotel_cost:1000,total_hotel_tax_amount:0,total_purchase_cost:1000,total_payable:1000,total_balance:1000}});if(changed.count!==1)throw new Error('Sample finance changed during correction');}
      return 'corrected 3 unpaid sample night rows to saved prices (INR 3000 total)';
    },{isolationLevel:'Serializable'});
  }

  private hotelSavedPriceTestMode():boolean {
    if(process.env.DVI_HOTEL_LOCAL_CONFIRMED_PRICE_TEST!=='yes'||process.env.NODE_ENV==='production')return false;
    try {const u=new URL(String(process.env.DATABASE_URL||''));return u.protocol==='mysql:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&!!u.pathname.slice(1)&&process.env.DVI_HOTEL_ISOLATED_TEST_DB==='yes';}catch{return false;}
  }
  // DVI_HOTEL_CONFIRMED_PURCHASE_V11: isolated local-test mapping from the saved
  // confirmed itinerary price. This must NEVER infer a real supplier liability.
  private async autoSavedPriceTestGroups(tx:any,p:any,headerId:number,rows:any[],drafts:any[],prior:any[],vouchers:any[],providers:any[]){
    const result:any={groups:[],reasons:[]};
    const fail=(reason:string)=>result.reasons.push(String(p.itinerary_quote_ID||'unknown')+': '+reason);
    const planId=Number(p.itinerary_plan_ID),confirmedId=Number(p.confirmed_itinerary_plan_ID);
    if(!this.hotelSavedPriceTestMode())return result;
    for(const r of rows){
      const id=Number(r.confirmed_itinerary_plan_hotel_details_ID);
      const originalId=Number(r.itinerary_plan_hotel_details_ID);
      const route=Number(r.itinerary_route_id);
      const date=this.autoHotelDay(r.itinerary_route_date);
      if(prior.some(f=>Number(f.cnf_itinerary_plan_hotel_details_ID)===id || Number(f.itinerary_plan_hotel_details_ID)===originalId))continue;
      const originals=drafts.filter(o=>Number(o.itinerary_plan_hotel_details_ID)===originalId),o=originals[0];
      const provider=this.autoHotelProvider(r.hotel_provider),code=String(r.hotel_code||'').trim();
      if(![id,originalId,route].every(n=>Number.isSafeInteger(n)&&n>0)||!date||![0,1].includes(Number(r.status))||Number(r.deleted)!==0||Number(r.hotel_required)!==1||Number(r.hotel_cancellation_status)!==0||originals.length!==1||!o||Number(o.deleted)!==0||Number(o.status)!==1||Number(o.hotel_required)!==1||Number(o.hotel_cancellation_status)!==0||Number(o.itinerary_route_id)!==route||this.autoHotelDay(o.itinerary_route_date)!==date||Number(r.itinerary_plan_hotel_details_ID)!==originalId||r.requires_price_reacceptance||o.requires_price_reacceptance||[r,o].some(x=>String(x.hotel_approval_status||'').toUpperCase()==='REJECTED')){fail('confirmed or original hotel is incomplete, changed or cancelled');continue;}
      if(this.autoHotelProvider(o.hotel_provider)!==provider||String(o.hotel_code||'').trim()!==code){fail('hotel provider or code changed');continue;}
      const hotelId=Number(r.hotel_id||0);
      if(!Number.isSafeInteger(hotelId)||hotelId<0||hotelId!==Number(o.hotel_id||0)){fail('hotel ID changed');continue;}
      // External hotel codes are genuine identities even if the old database has no dvi_hotel master row.
      if(hotelId===0&&(!provider||!code)){fail('external hotel requires a provider and code');continue;}
      if(hotelId>0){const mapped=await this.hotelReviewIdentity(tx,r);if(mapped!==hotelId){fail('internal hotel ID does not match master');continue;}}
      if(!Number.isSafeInteger(Number(r.total_no_of_rooms))||Number(r.total_no_of_rooms)<=0||Number(r.total_no_of_rooms)!==Number(o.total_no_of_rooms)){fail('room counts changed');continue;}
      if([r,o].some(x=>!!String(x.selected_currency||'').trim()&&String(x.selected_currency).trim().toUpperCase()!=='INR')){fail('non-INR hotel');continue;}
      const related=vouchers.filter(v=>Number(v.itinerary_plan_hotel_details_ID)===originalId||Number(v.confirmed_itinerary_plan_hotel_details_ID)===id);
      if(related.some(v=>Number(v.hotel_voucher_cancellation_status)===1||Number(v.hotel_booking_status)===2)){fail('cancelled hotel voucher');continue;}
      const matchedProviders=providers.filter(x=>Number(x.route)===route && x.provider===provider && x.code===code);
      if(matchedProviders.some(x=>!x.active)){fail('supplier cancellation or inactive booking');continue;}
      if(providers.some(x=>Number(x.route)===route && (x.provider!==provider||x.code!==code))){fail('conflicting supplier booking');continue;}
      const sell=this.autoHotelCents(r.total_hotel_cost),tax=this.autoHotelCents(r.total_hotel_tax_amount);
      if(sell===null||tax===null||sell+tax<=0){fail('invalid saved confirmed hotel price');continue;}
      // Reject competing finance assignments; never attach two payables to the same confirmed hotel row.
      if(prior.some(f=>Number(f.itinerary_route_id)===route && Number(f.hotel_id)===hotelId && Number(f.cnf_itinerary_plan_hotel_details_ID)!==id)){fail('other finance record already occupies hotel route');continue;}
      result.groups.push({planId,confirmedId,headerId,quote:String(p.itinerary_quote_ID||''),hotelId,provider:'local-saved-price-test',reference:'confirmed-row:'+id,checkIn:date,checkOut:new Date(Date.parse(date)+86400000).toISOString().slice(0,10),supplierTotal:sell+tax,confirmedAt:p.createdon?new Date(p.createdon).toISOString():'',allocations:[{id,originalId,route,date,sell,tax,base:sell,purchaseTax:tax,payable:sell+tax}],evidence:'ISOLATED-TEST-SAVED-PRICE-NOT-SUPPLIER-INVOICE'});
    }
    return result;
  }

  private autoHotelCents(v:any):number|null {
    if(v===null||v===undefined||v===''||typeof v==='boolean')return null;
    const n=Number(v);if(!Number.isFinite(n)||n<0||n>9999999)return null;
    return Math.round(n*100);
  }
  private autoHotelDay(v:any):string {const d=new Date(v);return v&&Number.isFinite(d.getTime())?d.toISOString().slice(0,10):'';}
  private autoHotelHash(v:any):string {return require('node:crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');}
  private autoHotelProvider(v:any):string {const p=String(v||'').trim().toLowerCase();return p==='vsr'?'tbo':p;}
  private async autoHotelCandidates(tx:any,planId:number,confirmedId:number) {
    const result:any={groups:[],reasons:[]};
    const skip=(reason:string)=>{result.reasons.push(reason);};
    const plans=await tx.dvi_confirmed_itinerary_plan_details.findMany({where:{itinerary_plan_ID:planId,status:1,deleted:0}});
    if(plans.length!==1||plans[0].confirmed_itinerary_plan_ID!==confirmedId){skip('ambiguous confirmed plan');return result;}
    const p=plans[0];
    const quote=String(p.itinerary_quote_ID||'').trim();
    if(!quote||(await tx.dvi_confirmed_itinerary_plan_details.findMany({where:{itinerary_quote_ID:quote,status:1,deleted:0}})).length!==1){skip('ambiguous booking code');return result;}
    const originals=await tx.dvi_itinerary_plan_details.findMany({where:{itinerary_plan_ID:planId,deleted:0}});
    if(originals.length!==1||String(originals[0].itinerary_quote_ID||'').trim()!==quote||(!this.hotelSavedPriceTestMode()&&Number(originals[0].quotation_status)!==1)){skip('original itinerary not confirmed or booking code mismatch');return result;}
    const headers=await tx.dvi_accounts_itinerary_details.findMany({where:{OR:[{itinerary_plan_ID:planId},{confirmed_itinerary_plan_ID:confirmedId}]}});
    if(headers.length!==1||headers[0].status!==1||headers[0].deleted!==0||headers[0].itinerary_plan_ID!==planId||headers[0].confirmed_itinerary_plan_ID!==confirmedId){skip('missing or ambiguous Accounts header');return result;}
    const headerId=headers[0].accounts_itinerary_details_ID;
    const [rows,drafts,prior,history,vouchers]=await Promise.all([
      tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,deleted:0}}),
      tx.dvi_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId}}),
      tx.dvi_accounts_itinerary_hotel_details.findMany({where:{OR:[{itinerary_plan_ID:planId},{accounts_itinerary_details_ID:headerId}]}}),
      tx.dvi_accounts_itinerary_hotel_transaction_history.findMany({where:{accounts_itinerary_details_ID:headerId}}),
      tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({where:{itinerary_plan_id:planId}})
    ]);
    if(!rows.length)return result;
    if(!rows.some((r:any)=>!prior.some((f:any)=>f.cnf_itinerary_plan_hotel_details_ID===r.confirmed_itinerary_plan_hotel_details_ID||f.itinerary_plan_hotel_details_ID===r.itinerary_plan_hotel_details_ID||f.itinerary_route_id===r.itinerary_route_id))){skip('no unposted hotel rows');return result;}
    if(history.some((h:any)=>!prior.some((f:any)=>f.accounts_itinerary_hotel_details_ID===h.accounts_itinerary_hotel_details_ID&&f.deleted===0))){skip('orphan payment history');return result;}
    const specs=[['tbo','tbo_hotel_booking_confirmation','tbo_hotel_code','tbo_booking_reference_number','net_amount'],['resavenue','resavenue_hotel_booking_confirmation','resavenue_hotel_code','resavenue_booking_reference','net_amount'],['axisrooms','axisrooms_hotel_booking_confirmation','axisrooms_hotel_code','axisrooms_booking_reference','net_amount'],['staah','staah_hotel_booking_confirmation','staah_hotel_code','staah_booking_reference','net_amount'],['hobse','hobse_hotel_booking_confirmation','hotel_code','booking_id','total_amount']];
    const providers:any[]=[];
    for(const [provider,model,code,ref,amount] of specs){
      if(!tx[model]){skip('supplier model unavailable: '+provider);return result;}
      const rr=await tx[model].findMany({where:provider==='hobse'?{plan_id:planId}:{itinerary_plan_ID:planId}});
      for(const r of rr)providers.push({provider,model,refField:ref,ref:String(r[ref]||'').trim(),code:String(r[code]||'').trim(),route:Number(provider==='hobse'?r.route_id:r.itinerary_route_ID),confirmed:provider==='hobse'?confirmedId:Number(r.confirmed_itinerary_plan_ID),amount:this.autoHotelCents(r[amount]),in:this.autoHotelDay(r.check_in_date),out:this.autoHotelDay(r.check_out_date),rooms:Number(provider==='hobse'?r.room_count:r.number_of_rooms),active:provider==='hobse'?r.booking_status==='confirmed'&&!r.cancellation_response:r.status===1&&r.deleted===0,raw:r});
    }
    if(this.hotelSavedPriceTestMode())return this.autoSavedPriceTestGroups(tx,p,headerId,rows,drafts,prior,vouchers,providers);
    const offline=await this.autoStoredOfflineGroups(tx,p,headerId,rows,drafts,prior,vouchers,providers);
    result.groups.push(...offline.groups);result.reasons.push(...offline.reasons);
    const groups=new Map<string,any[]>();
    for(const r of rows){
      const id=Number(r.confirmed_itinerary_plan_hotel_details_ID),route=Number(r.itinerary_route_id),provider=this.autoHotelProvider(r.hotel_provider),code=String(r.hotel_code||'').trim();
      if(prior.some((f:any)=>f.cnf_itinerary_plan_hotel_details_ID===id||f.itinerary_plan_hotel_details_ID===r.itinerary_plan_hotel_details_ID||f.itinerary_route_id===route)){skip('already posted or historical finance');continue;}
      const matches=providers.filter(x=>x.route===route);
      if(!provider||provider==='offline')continue;
      if(!code||matches.length!==1||matches[0].provider!==provider||matches[0].code!==code||!matches[0].active||matches[0].confirmed!==confirmedId||!matches[0].ref){skip('no unique active supplier confirmation');continue;}
      const b=matches[0];const key=JSON.stringify([provider,b.ref]);
      const list=groups.get(key)||[];list.push({r,b});groups.set(key,list);
    }
    const money=(r:any)=>[r.total_hotel_cost,r.total_hotel_tax_amount,r.hotel_margin_rate,r.hotel_margin_rate_tax_amt].map(x=>this.autoHotelCents(x));
    for(const list of groups.values()){
      const first=list[0].b, same=providers.filter(x=>x.provider===first.provider&&x.ref===first.ref);
      // Each reference represents one supplier stay, not one charge per route.
      if(same.length!==list.length||new Set(same.map(x=>x.route)).size!==same.length||same.some(x=>!x.active||x.confirmed!==confirmedId||x.code!==first.code||x.in!==first.in||x.out!==first.out||x.amount!==first.amount||x.rooms!==first.rooms)){skip('incomplete or conflicting multi-night supplier reference');continue;}
      const duplicateRef=await tx[first.model].findMany({where:{[first.refField]:first.ref}});
      if(duplicateRef.length!==same.length||duplicateRef.some((x:any)=>Number(first.provider==='hobse'?x.plan_id:x.itinerary_plan_ID)!==planId)){skip('supplier reference reused outside this stay');continue;}
      if(!first.in||!first.out||first.amount===null||first.amount<=0||!Number.isSafeInteger(first.rooms)||first.rooms<=0){skip('invalid supplier dates, rooms or total');continue;}
      // Hotel Collect means the guest may pay the hotel directly. Do not infer a DVI liability.
      if(first.provider==='staah'){skip('STAAH Hotel Collect workflow requires verified DVI liability; manual review');continue;}
      const dates=list.map(x=>this.autoHotelDay(x.r.itinerary_route_date)).sort();
      const nightCount=(Date.parse(first.out)-Date.parse(first.in))/86400000;
      if(!Number.isSafeInteger(nightCount)||nightCount<=0||nightCount!==dates.length||dates.some((d,i)=>d!==new Date(Date.parse(first.in)+i*86400000).toISOString().slice(0,10))){skip('night allocation not exactly verified');continue;}
      const allocations:any[]=[];let hotelId=0,valid=true;
      for(const {r,b} of list){
        const id=Number(r.confirmed_itinerary_plan_hotel_details_ID),originalId=Number(r.itinerary_plan_hotel_details_ID),route=Number(r.itinerary_route_id),date=this.autoHotelDay(r.itinerary_route_date);
        const o=drafts.find((x:any)=>x.itinerary_plan_hotel_details_ID===originalId);
        const field:Record<string,string>={tbo:'tbo_hotel_code',resavenue:'resavenue_hotel_code',axisrooms:'axisrooms_property_id',staah:'staah_property_id',hobse:'hotel_code'};
        const masters=await tx.dvi_hotel.findMany({where:{[field[b.provider]]:b.code,OR:[{deleted:false},{deleted:null}]}});
        const mapped=masters.length===1?Number(masters[0].hotel_id):0;
        const nums=money(r), origNums=o?money(o):[];
        if(!id||!originalId||!route||![0,1].includes(r.status)||r.hotel_required!==1||r.hotel_cancellation_status!==0||rows.filter((x:any)=>x.itinerary_route_id===route).length!==1||!o||o.deleted!==0||o.status!==1||o.hotel_required!==1||o.hotel_cancellation_status!==0||o.itinerary_route_id!==route||this.autoHotelDay(o.itinerary_route_date)!==date||this.autoHotelProvider(o.hotel_provider)!==b.provider||String(o.hotel_code||'').trim()!==b.code||String(r.selected_currency||'').toUpperCase()!=='INR'||String(o.selected_currency||'').toUpperCase()!=='INR'||(b.provider==='hobse'&&String(b.raw.currency||'').toUpperCase()!=='INR')||Number(r.total_no_of_rooms)!==first.rooms||!mapped||!String(masters[0].hotel_name||'').trim()||await this.hotelReviewIdentity(tx,r)!==mapped||await this.hotelReviewIdentity(tx,o)!==mapped||(hotelId&&hotelId!==mapped)||nums.some(x=>x===null)||JSON.stringify(nums)!==JSON.stringify(origNums)||vouchers.some((v:any)=>(v.itinerary_plan_hotel_details_ID===originalId||v.confirmed_itinerary_plan_hotel_details_ID===id)&&(v.hotel_voucher_cancellation_status===1||v.hotel_booking_status===2||(v.status===1&&v.deleted===0&&v.hotel_booking_status!==1)))){valid=false;break;}
        const [sell,tax,margin,marginTax]=nums as number[];const base=sell-margin,purchaseTax=tax-marginTax;
        if(base<0||purchaseTax<0||base+purchaseTax<=0){valid=false;break;}
        hotelId=mapped;allocations.push({id,originalId,route,date,sell,tax,base,purchaseTax,payable:base+purchaseTax});
      }
      if(!valid||allocations.reduce((s,x)=>s+x.payable,0)!==first.amount){skip('hotel identity, currency, purchase price or supplier total does not reconcile');continue;}
      allocations.sort((a,b)=>a.id-b.id);
      const group={planId,confirmedId,headerId,quote:String(p.itinerary_quote_ID||''),hotelId,provider:first.provider,reference:first.ref,checkIn:first.in,checkOut:first.out,supplierTotal:first.amount,confirmedAt:p.createdon?new Date(p.createdon).toISOString():'',allocations};
      result.groups.push(group);
    }
    return result;
  }
  async automaticHotelFinance(userId:number) {
    if(!Number.isSafeInteger(userId)||userId<=0)throw new BadRequestException('Authenticated Finance user required.');
    // Preview by default. Never create liabilities on a read-only GET or on production with this local patch.
    const allowed=new Set(String(process.env.DVI_HOTEL_AUTO_APPROVED_PROVIDERS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean));
    const savedPriceTest=this.hotelSavedPriceTestMode();
    let sampleCorrection='not requested';
    if(savedPriceTest){try{sampleCorrection=await this.correctHotelSamplePricesV9();}catch(e){sampleCorrection='sample correction failed; transaction rolled back';console.warn('[DVI_HOTEL_SAMPLE_CORRECTION_FAILED]',(e as any)?.code||'error');}console.log('[DVI_HOTEL_SAMPLE_CORRECTION]',sampleCorrection);}
    if(savedPriceTest)allowed.add('local-saved-price-test');
    const posting=savedPriceTest||(process.env.NODE_ENV!=='production'&&process.env.DVI_HOTEL_AUTO_MODE==='post'&&allowed.size>0);
    const plans=await this.prisma.dvi_confirmed_itinerary_plan_details.findMany({where:{status:1,deleted:0},select:{itinerary_plan_ID:true,confirmed_itinerary_plan_ID:true}});
    const counts=new Map<number,number>();for(const p of plans)counts.set(p.itinerary_plan_ID,(counts.get(p.itinerary_plan_ID)||0)+1);
    const groups:any[]=[],reasons:Record<string,number>={};
    const count=(r:string)=>{reasons[r]=(reasons[r]||0)+1;};
    for(const p of plans){if(counts.get(p.itinerary_plan_ID)!==1){count('ambiguous confirmed plan');continue;}
      try{const data=await this.autoHotelCandidates(this.prisma,p.itinerary_plan_ID,p.confirmed_itinerary_plan_ID);groups.push(...data.groups);data.reasons.forEach(count);}catch(e){count('candidate read failed');console.warn('[DVI_HOTEL_AUTO_READ_FAILED]',p.itinerary_plan_ID,(e as any)?.code||'error');}}
    groups.sort((a,b)=>a.planId-b.planId||a.provider.localeCompare(b.provider)||a.reference.localeCompare(b.reference));
    const approvedGroups=groups.filter(g=>allowed.has(g.provider));
    const cutoff=Date.parse(String(process.env.DVI_HOTEL_AUTO_NEW_FROM||''));
    const isNew=(g:any)=>g.provider!=='legacy-offline'&&Number.isFinite(cutoff)&&Number.isFinite(Date.parse(g.confirmedAt))&&Date.parse(g.confirmedAt)>=cutoff;
    const historical=approvedGroups.filter(g=>!isNew(g));
    const batchHash=this.autoHotelHash(historical);
    const approvedBatch=savedPriceTest||String(process.env.DVI_HOTEL_AUTO_APPROVED_BATCH||'')===batchHash;
    let created=0;const failures:any[]=[];
    if(posting){
      for(const g of approvedGroups){
        if(g.provider==='legacy-offline'&&process.env.DVI_HOTEL_AUTO_LEGACY_VERIFIED!=='yes'){count('legacy liability and payment history approval required');continue;}
        if(!isNew(g)&&!approvedBatch){count('historical batch approval required');continue;}
        try{
          const n=await this.prisma.$transaction(async tx=>{
            const fresh=await this.autoHotelCandidates(tx,g.planId,g.confirmedId);
            const current=fresh.groups.find((x:any)=>this.autoHotelHash(x)===this.autoHotelHash(g));
            if(!current)return 0;
            for(const a of current.allocations){await tx.dvi_accounts_itinerary_hotel_details.create({data:{accounts_itinerary_details_ID:current.headerId,itinerary_plan_hotel_details_ID:a.originalId,cnf_itinerary_plan_hotel_details_ID:a.id,itinerary_plan_ID:current.planId,itinerary_route_id:a.route,itinerary_route_date:new Date(a.date+'T00:00:00.000Z'),hotel_id:current.hotelId,total_hotel_cost:a.sell/100,total_hotel_tax_amount:a.tax/100,total_purchase_cost:a.base/100,total_payable:a.payable/100,total_paid:0,total_balance:a.payable/100,createdby:userId,createdon:new Date(),status:1,deleted:0}});}
            return current.allocations.length;
          },{isolationLevel:'Serializable'});
          created+=n;if(n)console.log('[DVI_HOTEL_AUTO_POSTED]',JSON.stringify({userId,quote:g.quote,provider:g.provider,reference:g.reference,totalINR:g.supplierTotal/100,rows:n}));
          else count('candidate changed or already posted');
        }catch(e){failures.push({planId:g.planId,provider:g.provider,code:(e as any)?.code||'error'});}
      }
    }
    const report={savedPriceTest,sampleCorrection,mode:posting?'post':'preview',eligibleGroups:groups.length,eligibleRows:groups.reduce((s,g)=>s+g.allocations.length,0),eligibleINR:groups.reduce((s,g)=>s+g.supplierTotal,0)/100,created,approvedProviders:[...allowed],historicalBatchHash:batchHash,historicalApproved:approvedBatch,reasons,failures};
    // Local server log is the review report. Do not share supplier references outside Finance.
    console.log('[DVI_HOTEL_AUTO_REPORT]',JSON.stringify(report));
    console.table(groups.map(g=>({booking:g.quote,provider:g.provider,reference:g.reference,verification:g.evidence||'supplier-confirmed',checkIn:g.checkIn,checkOut:g.checkOut,hotelId:g.hotelId,rows:g.allocations.length,payable:g.supplierTotal/100,approvedProvider:allowed.has(g.provider),new:isNew(g)})));
    return report;
  }

  private hotelReviewMoney(value: unknown): number {
    const str = String(value ?? '');
    if (!/^\d{1,7}(?:\.\d{1,2})?$/.test(str)) throw new BadRequestException('Enter a valid INR amount, max two decimals.');
    return Math.round(Number(str)*100);
  }
  private async hotelReviewIdentity(tx: any, row: any): Promise<number> {
    const provider=String(row.hotel_provider||'').trim().toLowerCase();
    const code=String(row.hotel_code||'').trim();
    const stored=Number(row.hotel_id||0);
    const fields: Record<string,string>={tbo:'tbo_hotel_code',vsr:'tbo_hotel_code',resavenue:'resavenue_hotel_code',staah:'staah_property_id',axisrooms:'axisrooms_property_id',hobse:'hotel_code'};
    let where: any;
    if (provider && code && fields[provider]) {
      where={ [fields[provider]]:code };
      if(provider==='staah') where={staah_enabled:1,AND:[{OR:[{staah_property_id:code},{hotel_code:code}]}]};
      if(provider==='axisrooms') where={axisrooms_enabled:1,AND:[{OR:[{axisrooms_property_id:code},{hotel_code:code}]}]};
    } else if(stored>0 && !code) where={hotel_id:stored};
    else if(stored>0 && !fields[provider]) where={hotel_id:stored};
    else return 0;
    if(this.hotelSavedPriceTestMode()&&code&&['staah','axisrooms'].includes(provider)){
      const exact=await tx.dvi_hotel.findMany({where:{[fields[provider]]:code,OR:[{deleted:false},{deleted:null}]},select:{hotel_id:true,hotel_name:true}});
      if(exact.length>1)return 0;
      if(exact.length===1){const id=Number(exact[0].hotel_id);return id>0&&String(exact[0].hotel_name||'').trim()&&(!stored||stored===id)?id:0;}
    }
    const masters=await tx.dvi_hotel.findMany({where:{...where,OR:[{deleted:false},{deleted:null}]},select:{hotel_id:true,hotel_name:true}});
    if(masters.length!==1||!String(masters[0].hotel_name||'').trim()){
      if(this.hotelSavedPriceTestMode()&&stored>0&&masters.length===0){const byId=await tx.dvi_hotel.findMany({where:{hotel_id:stored,OR:[{deleted:false},{deleted:null}]},select:{hotel_id:true,hotel_name:true}});if(byId.length===1&&String(byId[0].hotel_name||'').trim())return stored;}
      return 0;
    }
    const id=Number(masters[0].hotel_id);
    return stored>0&&stored!==id?0:id;
  }
  private async hotelReviewPlan(tx: any, body: any, unique: boolean) {
    const planId=Number(body?.planId), confirmedId=Number(body?.confirmedId);
    if(!Number.isSafeInteger(planId)||planId<=0||!Number.isSafeInteger(confirmedId)||confirmedId<=0) throw new BadRequestException('Invalid itinerary identity.');
    const plans=await tx.dvi_confirmed_itinerary_plan_details.findMany({where:{itinerary_plan_ID:planId,status:1,deleted:0}});
    const plan=plans.find((p:any)=>Number(p.confirmed_itinerary_plan_ID)===confirmedId);
    if(!plan||(unique&&plans.length!==1)) throw new BadRequestException('Confirmed plan missing or multiple active confirmations share this plan. Finance review required.');
    return {planId,confirmedId,plan};
  }
  async hotelFinanceIdentities(body: any) {
    const {planId}=await this.hotelReviewPlan(this.prisma,body,false);
    const rows=await this.prisma.dvi_confirmed_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,deleted:0}});
    const result=[] as Array<{confirmedHotelId:number;hotelId:number}>;
    for(const row of rows){
      const hotelId=await this.hotelReviewIdentity(this.prisma,row);
      result.push({confirmedHotelId:Number(row.confirmed_itinerary_plan_hotel_details_ID),hotelId});
    }
    return result;
  }
  async postReviewedHotelFinance(body:any, userId:number) {
    const reject=(m:string):never=>{throw new BadRequestException(m);};
    const entries=body?.rows;
    if(body?.supplierEvidenceVerified!==true||body?.noPriorPaymentsVerified!==true||!Array.isArray(entries)||!entries.length||entries.length>100) reject('Supplier confirmation, invoice and prior payment review are required.');
    const ids=entries.map((x:any)=>Number(x?.confirmedHotelId));
    if(ids.some((id:number)=>!Number.isSafeInteger(id)||id<=0)||new Set(ids).size!==ids.length) reject('Invalid or repeated hotel row IDs.');
    if(!Number.isSafeInteger(userId)||userId<=0) reject('Authenticated Finance user ID is required.');
    const result=await this.prisma.$transaction(async tx=>{
      const {planId,confirmedId}=await this.hotelReviewPlan(tx,body,true);
      const headers=await tx.dvi_accounts_itinerary_details.findMany({where:{OR:[{itinerary_plan_ID:planId},{confirmed_itinerary_plan_ID:confirmedId}]}});
      if(headers.length!==1||headers[0].status!==1||headers[0].deleted!==0||headers[0].itinerary_plan_ID!==planId||headers[0].confirmed_itinerary_plan_ID!==confirmedId) reject('Accounts header missing or ambiguous.');
      const headerId=headers[0].accounts_itinerary_details_ID;
      const all=await tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({where:{itinerary_plan_id:planId,deleted:0}});
      const rows=all.filter(r=>ids.includes(r.confirmed_itinerary_plan_hotel_details_ID));
      if(rows.length!==ids.length) reject('Hotel IDs do not belong to the confirmed booking.');
      const history=await tx.dvi_accounts_itinerary_hotel_transaction_history.findMany({where:{accounts_itinerary_details_ID:headerId}});
      const headerFinance=await tx.dvi_accounts_itinerary_hotel_details.findMany({where:{accounts_itinerary_details_ID:headerId}});
      if(history.some(h=>!headerFinance.some(f=>f.accounts_itinerary_hotel_details_ID===h.accounts_itinerary_hotel_details_ID&&f.deleted===0))) reject('Orphan or historical payment records require reconciliation before posting.');
      const hotelIds=new Set<number>();let created=0;
      for(const row of rows){
        const id=row.confirmed_itinerary_plan_hotel_details_ID, originalId=row.itinerary_plan_hotel_details_ID, route=row.itinerary_route_id;
        const entry=entries.find((e:any)=>Number(e.confirmedHotelId)===id);
        const hotelId=await this.hotelReviewIdentity(tx,row);hotelIds.add(hotelId);
        if(!hotelId||!originalId||!route||!row.itinerary_route_date||![0,1].includes(row.status)||row.hotel_required!==1||row.hotel_cancellation_status!==0||all.filter(r=>r.itinerary_route_id===route).length!==1) reject('Hotel identity, status or route is ambiguous: '+id);
        if(hotelIds.size!==1||Number(body.hotelId)!==hotelId) reject('Review exactly one verified hotel at a time.');
        const original=await tx.dvi_itinerary_plan_hotel_details.findFirst({where:{itinerary_plan_hotel_details_ID:originalId,itinerary_plan_id:planId,itinerary_route_id:route,deleted:0,status:1,hotel_required:1,hotel_cancellation_status:0}});
        if(!original||await this.hotelReviewIdentity(tx,original)!==hotelId||String(original.itinerary_route_date)!==String(row.itinerary_route_date)) reject('Original hotel assignment does not match: '+id);
        const voucher=await tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({where:{OR:[{itinerary_plan_hotel_details_ID:originalId},{confirmed_itinerary_plan_hotel_details_ID:id}]}});
        if(voucher.some(v=>v.hotel_voucher_cancellation_status===1||v.hotel_booking_status===2)) reject('Hotel cancellation history exists: '+id);
        if(voucher.some(v=>v.deleted===0&&v.status===1&&(v.hotel_booking_status!==1||v.itinerary_plan_id!==planId||v.hotel_id!==hotelId))) reject('Conflicting or pending hotel voucher: '+id);
        const bookingRef=String(entry?.bookingRef||'').trim(), invoiceRef=String(entry?.invoiceRef||'').trim();
        if(!bookingRef||!invoiceRef||bookingRef.length>120||invoiceRef.length>120) reject('Enter genuine booking and supplier invoice references for each stay.');
        const base=this.hotelReviewMoney(entry?.purchaseBase),tax=this.hotelReviewMoney(entry?.purchaseTax),payable=base+tax;
        if(payable<=0) reject('Supplier invoice amount must be positive.');
        const prior=await tx.dvi_accounts_itinerary_hotel_details.findMany({where:{OR:[{cnf_itinerary_plan_hotel_details_ID:id},{itinerary_plan_hotel_details_ID:originalId},{itinerary_plan_ID:planId,itinerary_route_id:route}]}});
        if(prior.length){
          const p=prior[0];if(prior.length!==1||p.deleted!==0||p.status!==1||p.accounts_itinerary_details_ID!==headerId||p.itinerary_plan_ID!==planId||p.cnf_itinerary_plan_hotel_details_ID!==id||p.itinerary_plan_hotel_details_ID!==originalId||p.hotel_id!==hotelId||p.itinerary_route_id!==route||String(p.itinerary_route_date)!==String(row.itinerary_route_date)||Math.round(Number(p.total_payable)*100)!==payable) reject('Existing or conflicting finance record: '+id);
          continue;
        }
        const sell=Number(row.total_hotel_cost),sellTax=Number(row.total_hotel_tax_amount);
        if(!Number.isFinite(sell)||sell<0||!Number.isFinite(sellTax)||sellTax<0) reject('Invalid original selling price: '+id);
        await tx.dvi_accounts_itinerary_hotel_details.create({data:{accounts_itinerary_details_ID:headerId,itinerary_plan_hotel_details_ID:originalId,cnf_itinerary_plan_hotel_details_ID:id,itinerary_plan_ID:planId,itinerary_route_id:route,itinerary_route_date:row.itinerary_route_date,hotel_id:hotelId,total_hotel_cost:sell,total_hotel_tax_amount:sellTax,total_purchase_cost:base/100,total_payable:payable/100,total_paid:0,total_balance:payable/100,createdby:userId,createdon:new Date(),status:1,deleted:0}});
        created++;
      }
      return {created,confirmedId,hotelId:[...hotelIds][0]};
    },{isolationLevel:'Serializable'});
    // Preserve review evidence in the application's audit log; no new schema fields.
    console.log('[DVI_HOTEL_FINANCE_REVIEW_COMMITTED]',JSON.stringify({userId,at:new Date().toISOString(),planId:Number(body.planId),confirmedId:Number(body.confirmedId),hotelId:Number(body.hotelId),created:result.created,rows:entries.map((e:any)=>({confirmedHotelId:Number(e.confirmedHotelId),bookingRef:String(e.bookingRef),invoiceRef:String(e.invoiceRef),purchaseBase:String(e.purchaseBase),purchaseTax:String(e.purchaseTax)}))}));
    return result;
  }
  async recordHotelFinanceBatch(body:any,userId:number,receiptPath:string) {
    const reject=(m:string):never=>{throw new BadRequestException(m);};
    let payments=body?.payments;
    if(typeof payments==='string'){try{payments=JSON.parse(payments);}catch{reject('Invalid payments JSON.');}}
    const reference=String(body?.utrNumber||'').trim(), processor=String(body?.processedBy||'').trim(), mode=Number(body?.modeOfPaymentId);
    if(!Array.isArray(payments)||!payments.length||payments.length>100||!reference||reference.length>120||!processor||processor.length>120||![1,2,3].includes(mode)||!Number.isSafeInteger(userId)||userId<=0) reject('Invalid hotel payment request.');
    const ids=payments.map((p:any)=>Number(p.componentDetailId));
    if(ids.some((i:number)=>!Number.isSafeInteger(i)||i<=0)||new Set(ids).size!==ids.length||payments.some((p:any)=>p.componentType!=='hotel')) reject('Hotel payments only; duplicate rows not permitted.');
    return this.prisma.$transaction(async tx=>{
      const rows=await tx.dvi_accounts_itinerary_hotel_details.findMany({where:{accounts_itinerary_hotel_details_ID:{in:ids}}});
      if(rows.length!==ids.length||new Set(rows.map(r=>r.hotel_id)).size!==1) reject('Select posted rows for one hotel only.');
      const hotelId=rows[0].hotel_id;
      let externalPayee='';
      const old=await tx.dvi_accounts_itinerary_hotel_transaction_history.findFirst({where:{transaction_utr_no:reference}});
      if(old) reject('Transaction reference already recorded. Reload and review payment history.');
      for(const row of rows){
        const p=payments.find((x:any)=>Number(x.componentDetailId)===row.accounts_itinerary_hotel_details_ID);
        const amount=this.hotelReviewMoney(p.amount), payable=this.hotelReviewMoney(Number(row.total_payable).toFixed(2)), paid=this.hotelReviewMoney(Number(row.total_paid).toFixed(2)), balance=this.hotelReviewMoney(Number(row.total_balance).toFixed(2));
        if((!hotelId&&!this.hotelSavedPriceTestMode())||row.status!==1||row.deleted!==0||row.accounts_itinerary_details_ID!==Number(p.accountsItineraryDetailsId)||payable!==paid+balance||amount<=0||amount>balance) reject('Finance row or balance changed. Reload and review.');
        const header=await tx.dvi_accounts_itinerary_details.findFirst({where:{accounts_itinerary_details_ID:row.accounts_itinerary_details_ID,itinerary_plan_ID:row.itinerary_plan_ID,status:1,deleted:0}});
        if(!header) reject('Accounts header unavailable.');
        await this.hotelReviewPlan(tx,{planId:row.itinerary_plan_ID,confirmedId:header!.confirmed_itinerary_plan_ID},true);
        const confirmed=await tx.dvi_confirmed_itinerary_plan_hotel_details.findFirst({where:{confirmed_itinerary_plan_hotel_details_ID:row.cnf_itinerary_plan_hotel_details_ID,itinerary_plan_id:row.itinerary_plan_ID,deleted:0,hotel_cancellation_status:0,hotel_required:1}});
        if(!confirmed||![0,1].includes(confirmed.status)||(hotelId>0&&await this.hotelReviewIdentity(tx,confirmed)!==hotelId)||(hotelId===0&&(!this.hotelSavedPriceTestMode()||Number(confirmed.hotel_id)!==0||!String(confirmed.hotel_code||'').trim()||!this.autoHotelProvider(confirmed.hotel_provider)))||confirmed.itinerary_plan_hotel_details_ID!==row.itinerary_plan_hotel_details_ID||confirmed.itinerary_route_id!==row.itinerary_route_id||String(confirmed.itinerary_route_date)!==String(row.itinerary_route_date)) reject('Hotel stay no longer matches the posted finance row.');
        const original=await tx.dvi_itinerary_plan_hotel_details.findFirst({where:{itinerary_plan_hotel_details_ID:row.itinerary_plan_hotel_details_ID,itinerary_plan_id:row.itinerary_plan_ID,itinerary_route_id:row.itinerary_route_id,deleted:0,hotel_cancellation_status:0,hotel_required:1,status:1}});
        if(!original||(hotelId>0&&await this.hotelReviewIdentity(tx,original)!==hotelId)||(hotelId===0&&(Number(original.hotel_id)!==0||this.autoHotelProvider(original.hotel_provider)!==this.autoHotelProvider(confirmed.hotel_provider)||String(original.hotel_code||'').trim()!==String(confirmed.hotel_code||'').trim()))) reject('Original hotel assignment is no longer active.');
        if(hotelId===0){const payee=this.autoHotelProvider(confirmed.hotel_provider)+':'+String(confirmed.hotel_code||'').trim();if(externalPayee&&externalPayee!==payee)reject('Cannot pay two supplier hotels in one batch.');externalPayee=payee;}
        const cancelled=await tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findFirst({where:{AND:[{OR:[{itinerary_plan_hotel_details_ID:row.itinerary_plan_hotel_details_ID},{confirmed_itinerary_plan_hotel_details_ID:row.cnf_itinerary_plan_hotel_details_ID}]},{OR:[{hotel_voucher_cancellation_status:1},{hotel_booking_status:2}]}]}});
        if(cancelled) reject('Cancelled hotel cannot be paid.');
        const result=await tx.dvi_accounts_itinerary_hotel_details.updateMany({where:{accounts_itinerary_hotel_details_ID:row.accounts_itinerary_hotel_details_ID,total_paid:row.total_paid,total_balance:row.total_balance,status:1,deleted:0},data:{total_paid:(paid+amount)/100,total_balance:(balance-amount)/100}});
        if(result.count!==1) reject('Concurrent payment detected; reload.');
        await tx.dvi_accounts_itinerary_hotel_transaction_history.create({data:{accounts_itinerary_hotel_details_ID:row.accounts_itinerary_hotel_details_ID,accounts_itinerary_details_ID:row.accounts_itinerary_details_ID,transaction_amount:amount/100,transaction_date:new Date(),transaction_done_by:processor,mode_of_pay:mode,transaction_utr_no:reference,transaction_attachment:receiptPath||'',createdby:userId,createdon:new Date(),status:1,deleted:0}});
      }
      return {recorded:rows.length};
    },{isolationLevel:'Serializable'});
  }

  private async repairReviewedHotelFinance(
    query: AccountsManagerQueryDto,
    allowedHeaderIds: number[],
  ): Promise<void> {
    const quote = String(process.env.DVI_LOCAL_HOTEL_REPAIR_QUOTE || '').trim();
    const requestedQuote = String(query.quoteId || query.search || '').trim();
    if (process.env.NODE_ENV === 'production' || query.componentType !== 'hotel' ||
        !quote || requestedQuote.toLowerCase() !== quote.toLowerCase() ||
        (query.quoteId && query.search && query.quoteId.trim().toLowerCase() !== query.search.trim().toLowerCase())) return;
    const rawIds = String(process.env.DVI_REVIEWED_HOTEL_FINANCE_IDS || '').trim();
    if (!rawIds) return;
    const parts = rawIds.split(',').map(v => v.trim());
    if (parts.some(v => !/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v)))) {
      throw new BadRequestException('Invalid finance-reviewed hotel detail IDs.');
    }
    const ids = [...new Set(parts.map(Number))];
    if (ids.length > 100) throw new BadRequestException('Review one booking at a time.');
    const reject = (reason: string): never => { throw new BadRequestException('Hotel finance review: ' + reason); };
    const cents = (v: unknown): number => {
      if (v === null || v === undefined || !Number.isFinite(Number(v)) || Number(v) < 0) reject('Invalid monetary source value.');
      const n = Math.round(Number(v) * 100);
      if (!Number.isSafeInteger(n)) reject('Invalid monetary precision.');
      return n;
    };

    // DVI_LOCAL_INVOICE_REVIEW_HOTEL_V3
    // Optional alternative to a missing historical voucher: actual supplier invoice
    // and booking evidence reviewed by Finance outside the application. Never derive
    // the payable from an unverified selling quote. Keep the review file for audit.
    type InvoiceReview = {
      confirmedHotelDetailId: number; originalHotelDetailId: number;
      hotelId: number; routeId: number; stayDate: string;
      supplierBookingReference: string; supplierInvoiceReference: string;
      purchaseBaseINR: string; purchaseTaxINR: string;
    };
    const invoiceReviews = new Map<number, InvoiceReview>();
    let reviewHash = '';
    const reviewPath = String(process.env.DVI_REVIEWED_HOTEL_FINANCE_FILE || '').trim();
    const reviewDate = (value: Date | null): string => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0,10) : '';
    const reviewMoney = (value: unknown): number => {
      if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) reject('Enter a verified INR amount with at most two decimals.');
      const [whole, fraction = ''] = String(value).split('.');
      return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    };
    if (reviewPath) {
      let review: any;
      try {
        const reviewFs = require('node:fs') as typeof import('node:fs');
        if (reviewFs.statSync(reviewPath).size > 1024 * 1024) reject('Review file is too large.');
        const raw = reviewFs.readFileSync(reviewPath, 'utf8');
        reviewHash = require('node:crypto').createHash('sha256').update(raw).digest('hex');
        review = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch { reject('Cannot read the Finance review JSON file.'); }
      if (!review || review.version !== 1 || review.bookingId !== quote || review.currency !== 'INR' ||
          typeof review.reviewedBy !== 'string' || !review.reviewedBy.trim() ||
          typeof review.reviewedAt !== 'string' || !Number.isFinite(Date.parse(review.reviewedAt)) || Date.parse(review.reviewedAt) > Date.now() + 60000 ||
          review.supplierEvidenceVerified !== true || review.noPriorSupplierPaymentsVerified !== true ||
          !Array.isArray(review.rows) || review.rows.length !== ids.length) reject('Incomplete Finance review, booking mismatch, or prior-payment attestation missing.');
      for (const entry of review.rows as InvoiceReview[]) {
        if (!entry || !ids.includes(entry.confirmedHotelDetailId) || invoiceReviews.has(entry.confirmedHotelDetailId) ||
            !Number.isSafeInteger(entry.originalHotelDetailId) || entry.originalHotelDetailId <= 0 ||
            !Number.isSafeInteger(entry.hotelId) || entry.hotelId <= 0 ||
            !Number.isSafeInteger(entry.routeId) || entry.routeId <= 0 ||
            typeof entry.stayDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.stayDate) ||
            typeof entry.supplierBookingReference !== 'string' || !entry.supplierBookingReference.trim() ||
            typeof entry.supplierInvoiceReference !== 'string' || !entry.supplierInvoiceReference.trim()) reject('Invalid supplier evidence or duplicate reviewed hotel detail ID.');
        if (reviewMoney(entry.purchaseBaseINR) + reviewMoney(entry.purchaseTaxINR) <= 0) reject('Verified supplier invoice must contain a positive payable.');
        invoiceReviews.set(entry.confirmedHotelDetailId, entry);
      }
    }
    await this.prisma.$transaction(async tx => {
      const plans = await tx.dvi_confirmed_itinerary_plan_details.findMany({where: {itinerary_quote_ID: quote, deleted: 0, status: 1}});
      if (plans.length !== 1) reject('Exact active confirmed booking not found or ambiguous.');
      const plan = plans[0];
      const planId = Number(plan.itinerary_plan_ID);
      const confirmedPlanId = Number(plan.confirmed_itinerary_plan_ID);
      if (!planId || !confirmedPlanId) reject('Invalid plan IDs.');
      const headers = await tx.dvi_accounts_itinerary_details.findMany({where: {OR: [{itinerary_plan_ID: planId}, {confirmed_itinerary_plan_ID: confirmedPlanId}]}});
      if (headers.length !== 1) reject('Missing or ambiguous Accounts header.');
      const h = headers[0];
      const headerId = Number(h.accounts_itinerary_details_ID);
      if (!allowedHeaderIds.includes(headerId) || Number(h.status) !== 1 || Number(h.deleted) !== 0 || Number(h.itinerary_plan_ID) !== planId || Number(h.confirmed_itinerary_plan_ID) !== confirmedPlanId || String(h.itinerary_quote_ID || '').toLowerCase() !== quote.toLowerCase()) reject('Accounts header or access scope mismatch.');
      const rows = await tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({where: {itinerary_plan_id: planId, confirmed_itinerary_plan_hotel_details_ID: {in: ids}}});
      if (rows.length !== ids.length) reject('Reviewed hotel IDs do not all belong to this booking.');
      const routeKeys = new Set<string>();
      const pending = [] as Array<{row: typeof rows[number]; confirmedId: number; originalId: number; routeId: number; hotelId: number; base: number; tax: number; purchaseBase: number; payable: number}>;
      for (const row of rows) {
        const confirmedId = Number(row.confirmed_itinerary_plan_hotel_details_ID);
        const originalId = Number(row.itinerary_plan_hotel_details_ID);
        const routeId = Number(row.itinerary_route_id);
        const hotelId = Number(row.hotel_id);
        const key = routeId + ':' + hotelId;
        if (!confirmedId || !originalId || !routeId || !hotelId || !row.itinerary_route_date || Number(row.deleted) !== 0 || ![0, 1].includes(Number(row.status)) || Number(row.hotel_required) !== 1 || Number(row.hotel_cancellation_status) !== 0 || routeKeys.has(key)) reject('Inactive/invalid/cancelled or ambiguous hotel identity: ' + confirmedId);
        routeKeys.add(key);
        const prior = await tx.dvi_accounts_itinerary_hotel_details.findMany({where: {OR: [{cnf_itinerary_plan_hotel_details_ID: confirmedId}, {itinerary_plan_hotel_details_ID: originalId}, {itinerary_plan_ID: planId, itinerary_route_id: routeId, hotel_id: hotelId}]}});
        if (prior.length) {
          const p = prior[0];
          if (prior.length !== 1 || Number(p.deleted) !== 0 || Number(p.status) !== 1 || Number(p.accounts_itinerary_details_ID) !== headerId || Number(p.itinerary_plan_ID) !== planId || Number(p.cnf_itinerary_plan_hotel_details_ID) !== confirmedId || Number(p.itinerary_plan_hotel_details_ID) !== originalId || Number(p.itinerary_route_id) !== routeId || Number(p.hotel_id) !== hotelId || String(p.itinerary_route_date) !== String(row.itinerary_route_date) || cents(p.total_payable) !== cents(p.total_paid) + cents(p.total_balance)) reject('Historical/conflicting finance record: ' + confirmedId);
          continue; // Never reset existing paid amounts; repeat requests are no-ops.
        }
        const original = await tx.dvi_itinerary_plan_hotel_details.findFirst({where: {itinerary_plan_hotel_details_ID: originalId, itinerary_plan_id: planId, itinerary_route_id: routeId, hotel_id: hotelId, hotel_required: 1, hotel_cancellation_status: 0, status: 1, deleted: 0}});
        if (!original || String(original.itinerary_route_date) !== String(row.itinerary_route_date)) reject('Original hotel assignment mismatch: ' + confirmedId);
        const siblings = await tx.dvi_confirmed_itinerary_plan_hotel_details.findMany({where: {itinerary_plan_id: planId, itinerary_route_id: routeId, deleted: 0}});
        if (siblings.length !== 1) reject('Ambiguous hotel assignment on route: ' + routeId);
        const master = await tx.dvi_hotel.findFirst({where: {hotel_id: hotelId}});
        if (!master || !String(master.hotel_name || '').trim()) reject('Hotel supplier identity missing: ' + confirmedId);
        const vouchers = await tx.dvi_confirmed_itinerary_plan_hotel_voucher_details.findMany({where: {OR: [{itinerary_plan_hotel_details_ID: originalId}, {confirmed_itinerary_plan_hotel_details_ID: confirmedId}]}});
        if (vouchers.some(v => Number(v.hotel_booking_status) === 2 || Number(v.hotel_voucher_cancellation_status) === 1)) reject('Cancellation history requires finance review: ' + confirmedId);
        const valid = vouchers.filter(v => Number(v.itinerary_plan_id) === planId && Number(v.hotel_id) === hotelId && Number(v.itinerary_plan_hotel_details_ID) === originalId && [0, confirmedId].includes(Number(v.confirmed_itinerary_plan_hotel_details_ID)) && Number(v.status) === 1 && Number(v.deleted) === 0 && Number(v.hotel_booking_status) === 1 && Number(v.hotel_voucher_cancellation_status) === 0 && String(v.itinerary_route_date) === String(row.itinerary_route_date));
        const invoiceReview = invoiceReviews.get(confirmedId);
        if (valid.length > 1) reject('Ambiguous confirmed supplier vouchers: ' + confirmedId);
        if (!invoiceReview && valid.length !== 1) reject('A unique confirmed supplier voucher or verified supplier invoice review is required: ' + confirmedId);
        if (invoiceReview && (invoiceReview.originalHotelDetailId !== originalId || invoiceReview.hotelId !== hotelId || invoiceReview.routeId !== routeId || invoiceReview.stayDate !== reviewDate(row.itinerary_route_date))) reject('Reviewed invoice does not match exact persisted hotel and stay identity: ' + confirmedId);
        // A live, explicitly pending voucher conflicts with an external invoice review.
        if (invoiceReview && !valid.length && vouchers.some(v => Number(v.deleted) === 0 && Number(v.status) === 1 && Number(v.hotel_booking_status) !== 1)) reject('Pending or conflicting supplier voucher requires review: ' + confirmedId);
        const base = cents(row.total_hotel_cost), tax = cents(row.total_hotel_tax_amount), margin = cents(row.hotel_margin_rate), marginTax = cents(row.hotel_margin_rate_tax_amt);
        if (base !== cents(original!.total_hotel_cost) || tax !== cents(original!.total_hotel_tax_amount) || margin !== cents(original!.hotel_margin_rate) || marginTax !== cents(original!.hotel_margin_rate_tax_amt)) reject('Original and confirmed pricing differ: ' + confirmedId);
        if (!invoiceReview && (base < margin || tax < marginTax || base - margin + tax - marginTax <= 0)) reject('Supplier cost/margin/tax inconsistent: ' + confirmedId);
        const purchaseBase = invoiceReview ? reviewMoney(invoiceReview.purchaseBaseINR) : base - margin;
        const purchaseTax = invoiceReview ? reviewMoney(invoiceReview.purchaseTaxINR) : tax - marginTax;
        // Preserve the original selling amounts; a verified supplier invoice is the
        // source of the supplier purchase amount, not a correction to the old quote.
        pending.push({row, confirmedId, originalId, routeId, hotelId, base, tax, purchaseBase, payable: purchaseBase + purchaseTax});
      }
      if (!pending.length) return;
      const history = await tx.dvi_accounts_itinerary_hotel_transaction_history.findFirst({where: {accounts_itinerary_details_ID: headerId}});
      if (history) reject('Prior hotel payment history exists under this header. Manual reconciliation required.');
      // The allowlist is a Finance attestation that the supplier liability and absence of any outside payments were verified.
      // All reads/checks precede creation, within the same serializable transaction.
      for (const p of pending) {
        await tx.dvi_accounts_itinerary_hotel_details.create({data: {
          accounts_itinerary_details_ID: headerId,
          itinerary_plan_hotel_details_ID: p.originalId,
          cnf_itinerary_plan_hotel_details_ID: p.confirmedId,
          itinerary_plan_ID: planId,
          itinerary_route_id: p.routeId,
          itinerary_route_date: p.row.itinerary_route_date,
          hotel_id: p.hotelId,
          total_hotel_cost: p.base / 100,
          total_hotel_tax_amount: p.tax / 100,
          total_purchase_cost: p.purchaseBase / 100,
          total_payable: p.payable / 100,
          total_paid: 0,
          total_balance: p.payable / 100,
          createdby: Number(plan.createdby || 0),
          createdon: new Date(), status: 1, deleted: 0,
        }});
      }
    }, {isolationLevel: 'Serializable'});
    if (reviewHash) console.log('[DVI_HOTEL_INVOICE_REVIEW_COMMITTED]', JSON.stringify({quote, confirmedHotelDetailIds: ids, reviewSha256: reviewHash}));
  }

  async list(query: AccountsManagerQueryDto, allowHotelRepair = false): Promise<AccountsManagerRowDto[]> {
    const status: AccountsManagerStatus = query.status || "all";
    const componentType: AccountsManagerComponentType =
      query.componentType || "all";

    const fromDate = parseDDMMYYYY(query.fromDate);
 const toDate = parseDDMMYYYY(query.toDate, true); // end of day

 // 1 Base filter on accounts header
    const detailsWhere: any = {
      deleted: 0,
    };

    if (query.quoteId) {
      detailsWhere.itinerary_quote_ID = {
        contains: query.quoteId,
      };
    }

    if (query.agentId) {
      detailsWhere.agent_id = Number(query.agentId);
    } else if ((query as any).travelExpertId) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: Number((query as any).travelExpertId), deleted: 0 },
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID));
      detailsWhere.agent_id = { in: teAgentIds };
    }

    if (fromDate && toDate) {
      detailsWhere.trip_start_date_and_time = { gte: fromDate };
      detailsWhere.trip_end_date_and_time = { lte: toDate };
    } else if (fromDate) {
      detailsWhere.trip_start_date_and_time = { gte: fromDate };
    } else if (toDate) {
      detailsWhere.trip_end_date_and_time = { lte: toDate };
    }

    const headers = await this.prisma.dvi_accounts_itinerary_details.findMany({
      where: detailsWhere,
      select: {
        accounts_itinerary_details_ID: true,
        itinerary_quote_ID: true,
        itinerary_plan_ID: true,
        agent_id: true,
        trip_start_date_and_time: true,
        trip_end_date_and_time: true,
        total_received_amount: true,
        total_payout_amount: true,
      },
    });

    if (!headers.length) {
      return [];
    }

    const headersById = new Map<number, (typeof headers)[number]>();
    const headerIds: number[] = [];

    for (const h of headers) {
      headersById.set(h.accounts_itinerary_details_ID, h);
      headerIds.push(h.accounts_itinerary_details_ID);
    }

    const planIds = Array.from(new Set(headers.map(h => h.itinerary_plan_ID).filter(id => id > 0)));
    const plans = planIds.length
      ? await this.prisma.dvi_itinerary_plan_details.findMany({
          where: { itinerary_plan_ID: { in: planIds } },
          select: {
            itinerary_plan_ID: true,
            arrival_location: true,
            departure_location: true,
            total_adult: true,
            total_children: true,
            total_infants: true,
          }
        })
      : [];

    const planMap = new Map<number, any>();
    for (const p of plans) {
      planMap.set(p.itinerary_plan_ID, p);
    }

 // 2 Agents map (for agent name filter + display)
    const agentIds = Array.from(
      new Set(headers.map((h) => h.agent_id).filter((x) => x && x > 0)),
    );

    const agents = agentIds.length
      ? await this.prisma.dvi_agent.findMany({
          where: {
            agent_ID: { in: agentIds },
          },
          select: {
            agent_ID: true,
            agent_name: true,
          },
        })
      : [];

    const agentMap = new Map<number, string>();
    for (const a of agents) {
      agentMap.set(a.agent_ID, a.agent_name || "");
    }

 // If agent name filter is provided, restrict headers here
    let filteredHeaderIds = headerIds;
    if (query.agent) {
      const needle = query.agent.toLowerCase();
      filteredHeaderIds = headerIds.filter((id) => {
        const header = headersById.get(id);
        if (!header) return false;
        const aName = (agentMap.get(header.agent_id) || "").toLowerCase();
        return aName.includes(needle);
      });
    }

    if (!filteredHeaderIds.length) {
      return [];
    }

    const shouldIncludeByStatus = (balance: number): boolean => {
      const rowStatus: "paid" | "due" = balance === 0 ? "paid" : "due";
      if (status === "all") return true;
      return status === rowStatus;
    };

    const rows: AccountsManagerRowDto[] = [];

 // Shared helper to build base row from header
    const buildBaseRow = (
      detailHeaderId: number,
      vendorName: string,
      amount: number,
      paid: number,
      balance: number,
      component: AccountsManagerRowComponentType,
    ): AccountsManagerRowDto | null => {
      if (!shouldIncludeByStatus(balance)) return null;

      const header = headersById.get(detailHeaderId);
      if (!header) return null;

      const plan = planMap.get(header.itinerary_plan_ID);
      const quoteId = header.itinerary_quote_ID || "";
      const agentName = agentMap.get(header.agent_id) || "";

 // search filter (quote + vendor name)
      if (query.search) {
        const s = query.search.toLowerCase();
        if (
          !quoteId.toLowerCase().includes(s) &&
          !vendorName.toLowerCase().includes(s)
        ) {
          return null;
        }
      }

      const rowStatus: "paid" | "due" = balance === 0 ? "paid" : "due";

      const startDate = formatToDDMMYYYY(header.trip_start_date_and_time);
      const endDate = formatToDDMMYYYY(header.trip_end_date_and_time);
 // In PHP this is itinerary_route_date; here we default to trip start date
      const routeDate = startDate;

      return {
 headerId: detailHeaderId, // header row ID (accounts_itinerary_details_ID)
 id: detailHeaderId, // will be overwritten per component with detail row id
        quoteId,
        hotelName: vendorName,
        amount,
        payout: paid,
        payable: balance,
        status: rowStatus,
        componentType: component,
        agent: agentName,
        startDate,
        endDate,
        routeDate,
 // per-component enrichments will fill these:
        vendorId: undefined,
        vehicleId: undefined,
        arrivalLocation: plan?.arrival_location || "",
        departureLocation: plan?.departure_location || "",
        guestName: plan ? `Adult: ${plan.total_adult}, Child: ${plan.total_children}` : "",
        inhandAmount: (header.total_received_amount || 0) - (header.total_payout_amount || 0),
      };
    };

 // 3 HOTEL component
    if (componentType === "all" || componentType === "hotel") {
      if (allowHotelRepair && componentType === "hotel") {
        await this.repairReviewedHotelFinance(query, filteredHeaderIds);
      }
      const hotelDetails =
        await this.prisma.dvi_accounts_itinerary_hotel_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_hotel_details_ID: true,
            accounts_itinerary_details_ID: true,
            hotel_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            total_hotel_cost: true,
            total_hotel_tax_amount: true,
            total_purchase_cost: true,
          },
        });

      const hotelIds = Array.from(
        new Set(hotelDetails.map((h) => h.hotel_id).filter((x) => x && x > 0)),
      );

      const hotels = hotelIds.length
        ? await this.prisma.dvi_hotel.findMany({
            where: { hotel_id: { in: hotelIds } },
            select: { hotel_id: true, hotel_name: true },
          })
        : [];

      const hotelMap = new Map<number, string>();
      for (const h of hotels) {
        hotelMap.set(h.hotel_id, h.hotel_name || "");
      }

      for (const hd of hotelDetails) {
        const vendorName = hotelMap.get(hd.hotel_id) || "Hotel";
        const base = buildBaseRow(
          hd.accounts_itinerary_details_ID,
          vendorName,
          hd.total_payable,
          hd.total_paid,
          hd.total_balance,
          "hotel",
        );
        if (!base) continue;
        base.id = hd.accounts_itinerary_hotel_details_ID;
 // match PHP: hotel_id as vendorId
        base.vendorId = hd.hotel_id || undefined;

        base.receivableFromAgentAmount = (hd.total_hotel_cost || 0) + (hd.total_hotel_tax_amount || 0);
        base.marginAmount = (hd.total_hotel_cost || 0) - (hd.total_purchase_cost || 0);
        base.tax = hd.total_hotel_tax_amount || 0;

        rows.push(base);
      }
    }

 // 4 GUIDE component
    if (componentType === "all" || componentType === "guide") {
      const guideDetails =
        await this.prisma.dvi_accounts_itinerary_guide_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_guide_details_ID: true,
            accounts_itinerary_details_ID: true,
            guide_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            guide_slot_cost: true,
          },
        });

      const guideIds = Array.from(
        new Set(
          guideDetails.map((g) => g.guide_id).filter((x) => x && x > 0),
        ),
      );

      const guides = guideIds.length
        ? await this.prisma.dvi_guide_details.findMany({
            where: { guide_id: { in: guideIds } },
            select: { guide_id: true, guide_name: true },
          })
        : [];

      const guideMap = new Map<number, string>();
      for (const g of guides) {
        guideMap.set(g.guide_id, g.guide_name || "");
      }

      for (const gd of guideDetails) {
        const vendorName = guideMap.get(gd.guide_id) || "Guide";
        const base = buildBaseRow(
          gd.accounts_itinerary_details_ID,
          vendorName,
          gd.total_payable,
          gd.total_paid,
          gd.total_balance,
          "guide",
        );
        if (!base) continue;
        base.id = gd.accounts_itinerary_guide_details_ID;
 // PHP semantics: guide_id as vendorId
        base.vendorId = gd.guide_id || undefined;
        rows.push(base);
      }
    }

 // 5 HOTSPOT component
    if (componentType === "all" || componentType === "hotspot") {
      const hotspotDetails =
        await this.prisma.dvi_accounts_itinerary_hotspot_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_hotspot_details_ID: true,
            accounts_itinerary_details_ID: true,
            hotspot_ID: true,
            hotspot_amount: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
          },
        });

      const hotspotIds = Array.from(
        new Set(
          hotspotDetails.map((h) => h.hotspot_ID).filter((x) => x && x > 0),
        ),
      );

      const hotspots = hotspotIds.length
        ? await this.prisma.dvi_hotspot_place.findMany({
            where: { hotspot_ID: { in: hotspotIds } },
            select: { hotspot_ID: true, hotspot_name: true },
          })
        : [];

      const hotspotMap = new Map<number, string>();
      for (const h of hotspots) {
        hotspotMap.set(h.hotspot_ID, h.hotspot_name || "");
      }

      for (const hd of hotspotDetails) {
        const vendorName = hotspotMap.get(hd.hotspot_ID) || "Hotspot";
        const amount = hd.hotspot_amount ?? hd.total_payable;
        const base = buildBaseRow(
          hd.accounts_itinerary_details_ID,
          vendorName,
          amount,
          hd.total_paid,
          hd.total_balance,
          "hotspot",
        );
        if (!base) continue;
        base.id = hd.accounts_itinerary_hotspot_details_ID;
 // PHP semantics: hotspot_ID as vendorId
        base.vendorId = hd.hotspot_ID || undefined;
        rows.push(base);
      }
    }

 // 6 ACTIVITY component
    if (componentType === "all" || componentType === "activity") {
      const activityDetails =
        await this.prisma.dvi_accounts_itinerary_activity_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_activity_details_ID: true,
            accounts_itinerary_details_ID: true,
            activity_ID: true,
            activity_amount: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
          },
        });

      const activityIds = Array.from(
        new Set(
          activityDetails.map((a) => a.activity_ID).filter((x) => x && x > 0),
        ),
      );

      const activities = activityIds.length
        ? await this.prisma.dvi_activity.findMany({
            where: { activity_id: { in: activityIds } },
            select: { activity_id: true, activity_title: true },
          })
        : [];

      const activityMap = new Map<number, string>();
      for (const a of activities) {
        activityMap.set(a.activity_id, a.activity_title || "");
      }

      for (const ad of activityDetails) {
        const vendorName = activityMap.get(ad.activity_ID) || "Activity";
        const amount = ad.activity_amount ?? ad.total_payable;
        const base = buildBaseRow(
          ad.accounts_itinerary_details_ID,
          vendorName,
          amount,
          ad.total_paid,
          ad.total_balance,
          "activity",
        );
        if (!base) continue;
        base.id = ad.accounts_itinerary_activity_details_ID;
 // PHP semantics: activity_ID as vendorId
        base.vendorId = ad.activity_ID || undefined;
        rows.push(base);
      }
    }

 // 7 VEHICLE component
    if (componentType === "all" || componentType === "vehicle") {
      const vehicleDetails =
        await this.prisma.dvi_accounts_itinerary_vehicle_details.findMany({
          where: {
            deleted: 0,
            accounts_itinerary_details_ID: { in: filteredHeaderIds },
          },
          select: {
            accounts_itinerary_vehicle_details_ID: true,
            accounts_itinerary_details_ID: true,
            vehicle_id: true,
            total_payable: true,
            total_paid: true,
            total_balance: true,
            vehicle_grand_total: true,
            total_purchase: true,
          },
        });

      const vehicleIds = Array.from(
        new Set(
          vehicleDetails.map((v) => v.vehicle_id).filter((x) => x && x > 0),
        ),
      );

      const vehicles = vehicleIds.length
        ? await this.prisma.dvi_vehicle.findMany({
            where: { vehicle_id: { in: vehicleIds } },
            select: {
              vehicle_id: true,
              registration_number: true,
              owner_name: true,
            },
          })
        : [];

// (continue)
      const vehicleMap = new Map<number, string>();
      for (const v of vehicles) {
        const label =
          v.registration_number ||
          v.owner_name ||
          `Vehicle #${v.vehicle_id}`;
        vehicleMap.set(v.vehicle_id, label);
      }

      for (const vd of vehicleDetails) {
        const vendorName = vehicleMap.get(vd.vehicle_id) || "Vehicle";
        const base = buildBaseRow(
          vd.accounts_itinerary_details_ID,
          vendorName,
          vd.total_payable,
          vd.total_paid,
          vd.total_balance,
          "vehicle",
        );
        if (!base) continue;
        base.id = vd.accounts_itinerary_vehicle_details_ID;
 // expose both vehicleId (for detail popup) and vendorId if needed
        base.vehicleId = vd.vehicle_id || undefined;
 // vendorId can also point to the same, like PHP often uses vendor/vehicle lookup
        base.vendorId = vd.vehicle_id || undefined;

        base.receivableFromAgentAmount = (vd.vehicle_grand_total || 0);
        base.marginAmount = (vd.vehicle_grand_total || 0) - (vd.total_purchase || 0);
        base.tax = 0;

        rows.push(base);
      }
    }

 // 8 Sort by start date desc + quoteId as fallback
    rows.sort((a, b) => {
      const da = toComparable(a.startDate);
      const db = toComparable(b.startDate);
      if (da === db) {
        return (b.quoteId || "").localeCompare(a.quoteId || "");
      }
      return db.localeCompare(da);
    });

    return rows;
  }

 /**
   * 🔹 Internal helper used by summary/query endpoints.
   * Rebuilds the same header filtering logic used in list(),
   * but only returns the header IDs + normalized status/componentType.
 */
  private async getFilteredHeaderIds(
    query: AccountsManagerQueryDto,
  ): Promise<{
    headerIds: number[];
    status: AccountsManagerStatus;
    componentType: AccountsManagerComponentType;
  }> {
    const status: AccountsManagerStatus = query.status || "all";
    const componentType: AccountsManagerComponentType =
      query.componentType || "all";

    const fromDate = parseDDMMYYYY(query.fromDate);
    const toDate = parseDDMMYYYY(query.toDate, true);

    const where: any = {
      deleted: 0,
    };

    if (query.quoteId) {
      where.itinerary_quote_ID = {
        contains: query.quoteId,
      };
    }

    if (query.agentId) {
      where.agent_id = Number(query.agentId);
    } else if ((query as any).travelExpertId) {
      const teAgents = await this.prisma.dvi_agent.findMany({
        where: { travel_expert_id: Number((query as any).travelExpertId), deleted: 0 },
        select: { agent_ID: true },
      });
      const teAgentIds = teAgents.map((a) => Number(a.agent_ID));
      where.agent_id = { in: teAgentIds };
    }

    if (fromDate && toDate) {
      where.trip_start_date_and_time = { gte: fromDate };
      where.trip_end_date_and_time = { lte: toDate };
    } else if (fromDate) {
      where.trip_start_date_and_time = { gte: fromDate };
    } else if (toDate) {
      where.trip_end_date_and_time = { lte: toDate };
    }

    const headers = await this.prisma.dvi_accounts_itinerary_details.findMany({
      where,
      select: {
        accounts_itinerary_details_ID: true,
        agent_id: true,
      },
    });

    if (!headers.length) {
      return { headerIds: [], status, componentType };
    }

    const headerIds = headers.map(
      (h) => h.accounts_itinerary_details_ID,
    );

 // Agent filter (same behaviour as list)
    if (query.agent) {
      const agentIds = Array.from(
        new Set(headers.map((h) => h.agent_id).filter((x) => x && x > 0)),
      );

      const agents = agentIds.length
        ? await this.prisma.dvi_agent.findMany({
            where: {
              agent_ID: { in: agentIds },
            },
            select: {
              agent_ID: true,
              agent_name: true,
            },
          })
        : [];

      const agentMap = new Map<number, string>();
      for (const a of agents) {
        agentMap.set(a.agent_ID, a.agent_name || "");
      }

      const needle = query.agent.toLowerCase();
      const filtered = headers.filter((h) => {
        const aName = (agentMap.get(h.agent_id) || "").toLowerCase();
        return aName.includes(needle);
      });

      return {
        headerIds: filtered.map(
          (h) => h.accounts_itinerary_details_ID,
        ),
        status,
        componentType,
      };
    }

    return { headerIds, status, componentType };
  }

 /**
   * 🔹 GET /accounts-manager/summary
   * Aggregates total_payable / total_paid / total_balance across
   * all visible component rows based on filters.
 */
  async getSummary(
    query: AccountsManagerQueryDto,
  ): Promise<AccountsManagerSummaryDto> {
    const { headerIds, status, componentType } =
      await this.getFilteredHeaderIds(query);

    if (!headerIds.length) {
      return {
        totalPayable: 0,
        totalPaid: 0,
        totalBalance: 0,
        rowCount: 0,
      };
    }

    const includeTypes: AccountsManagerRowComponentType[] =
      componentType === "all"
        ? ["guide", "hotspot", "activity", "hotel", "vehicle"]
        : [componentType as AccountsManagerRowComponentType];

    const applyStatusFilter = <
      T extends { total_balance: number | null | undefined },
    >(
      rows: T[],
    ) => {
      if (status === "all") return rows;
      return rows.filter((r) => {
        const bal = Number(r.total_balance ?? 0);
        const isPaid = bal === 0;
        return status === "paid" ? isPaid : !isPaid;
      });
    };

    let totalPayable = 0;
    let totalPaid = 0;
    let totalBalance = 0;
    let rowCount = 0;

 // HOTEL
    if (includeTypes.includes("hotel")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_hotel_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // VEHICLE
    if (includeTypes.includes("vehicle")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_vehicle_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // GUIDE
    if (includeTypes.includes("guide")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_guide_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // HOTSPOT
    if (includeTypes.includes("hotspot")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_hotspot_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

 // ACTIVITY
    if (includeTypes.includes("activity")) {
      const rows =
        await this.prisma.dvi_accounts_itinerary_activity_details.findMany(
          {
            where: {
              deleted: 0,
              accounts_itinerary_details_ID: { in: headerIds },
            },
            select: {
              total_payable: true,
              total_paid: true,
              total_balance: true,
            },
          },
        );
      const filtered = applyStatusFilter(rows);
      for (const r of filtered) {
        totalPayable += Number(r.total_payable ?? 0);
        totalPaid += Number(r.total_paid ?? 0);
        totalBalance += Number(r.total_balance ?? 0);
      }
      rowCount += filtered.length;
    }

    return {
      totalPayable,
      totalPaid,
      totalBalance,
      rowCount,
    };
  }

 /**
   * 🔹 GET /accounts-manager/quotes?q=...
   * Quote autocomplete – distinct itinerary_quote_ID values.
 */
  async searchQuotes(
    phrase: string,
  ): Promise<AccountsManagerQuoteDto[]> {
    const where: any = {};

    if (phrase) {
      where.itinerary_quote_ID = {
        contains: phrase,
      };
    }

    const rows =
      await this.prisma.dvi_accounts_itinerary_details.findMany({
        where,
        distinct: ["itinerary_quote_ID"],
        select: {
          itinerary_quote_ID: true,
        },
        orderBy: {
          accounts_itinerary_details_ID: "desc",
        },
        take: 20,
      });

    return rows
      .map((r) => (r.itinerary_quote_ID || "").trim())
      .filter((q) => !!q)
      .map((q) => ({ quoteId: q }));
  }

 /**
   * 🔹 GET /accounts-manager/agents
   * Agent dropdown – simple list of all agents.
 */
  async listAgents(): Promise<AccountsManagerAgentDto[]> {
    const agents = await this.prisma.dvi_agent.findMany({
      select: {
        agent_ID: true,
        agent_name: true,
      },
      orderBy: {
        agent_name: "asc",
      },
    });

 console.log("Fetched agents:", agents.length);

    return agents.map((a) => ({
      id: a.agent_ID,
      name: a.agent_name || "",
    }));
  }

 /**
   * 🔹 GET /accounts-manager/payment-modes
   * Returns static payment modes (aligned with PHP: 1=Cash, 2=UPI, 3=Net Banking).
 */
  async listPaymentModes(): Promise<AccountsManagerPaymentModeDto[]> {
    return [
      { id: 1, label: "Cash" },
      { id: 2, label: "UPI" },
      { id: 3, label: "Net Banking" },
    ];
  }

 /**
   * 🔹 POST /accounts-manager/pay
   * Updates total_paid & total_balance for a single component row
   * AND inserts a row into the corresponding *_transaction_history table.
 */
  async recordPayment(body: AccountsManagerPayDto): Promise<void> {
    const {
      componentType,
      componentDetailId,
 // accountsItineraryDetailsId, // ignored for now to avoid strict mismatch
      amount,
    } = body;

    if (amount <= 0) {
      throw new BadRequestException("Amount must be greater than zero");
    }

    let detail: any;
    let updateFn: (data: any) => Promise<any>;

    switch (componentType) {
      case "hotel": {
        const model = this.prisma.dvi_accounts_itinerary_hotel_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_hotel_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_hotel_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "vehicle": {
        const model = this.prisma.dvi_accounts_itinerary_vehicle_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_vehicle_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_vehicle_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "guide": {
        const model = this.prisma.dvi_accounts_itinerary_guide_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_guide_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_guide_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "hotspot": {
        const model = this.prisma.dvi_accounts_itinerary_hotspot_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_hotspot_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_hotspot_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      case "activity": {
        const model = this.prisma.dvi_accounts_itinerary_activity_details;
        detail = await model.findUnique({
          where: {
            accounts_itinerary_activity_details_ID: componentDetailId,
          },
        });
        updateFn = (data) =>
          model.update({
            where: {
              accounts_itinerary_activity_details_ID: componentDetailId,
            },
            data,
          });
        break;
      }
      default:
        throw new BadRequestException(
          `Unsupported componentType: ${componentType}`,
        );
    }

    if (!detail || detail.deleted === 1) {
      throw new BadRequestException("Component row not found or deleted");
    }

 // Use the header ID from detail row to avoid strict mismatch errors
    const headerId = Number(detail.accounts_itinerary_details_ID);

    const currentPaid = Number(detail.total_paid ?? 0);
    const currentBalance = Number(detail.total_balance ?? 0);

    if (amount > currentBalance) {
      throw new BadRequestException(
        "Amount cannot be greater than current balance",
      );
    }

    const newPaid = currentPaid + amount;
    const newBalance = currentBalance - amount;

 // 1 Update running totals on the *_details row
    await updateFn({
      total_paid: newPaid,
      total_balance: newBalance,
    });

 // 2 Insert into the appropriate *_transaction_history table
    await this.createTransactionHistory(body, amount, headerId);
  }

 /**
   * Inserts a row into the legacy transaction history tables:
   * - dvi_accounts_itinerary_hotel_transaction_history
   * - dvi_accounts_itinerary_vehicle_transaction_history
   * - dvi_accounts_itinerary_hotspot_transaction_history
   * - dvi_accounts_itinerary_activity_transaction_history
   * - dvi_accounts_itinerary_guide_transaction_history
 */
  private async createTransactionHistory(
    body: AccountsManagerPayDto,
    amount: number,
    headerId: number,
  ): Promise<void> {
    const {
      componentType,
      componentDetailId,
      modeOfPaymentId,
      utrNumber,
      processedBy,
      routeDate,
      paymentScreenshotPath,
    } = body;

    const transactionDate =
      routeDate ? parseDDMMYYYY(routeDate) ?? new Date() : new Date();

 // `any` avoids Prisma union type mismatch between different *_transaction_history tables
    const common: any = {
      accounts_itinerary_details_ID: headerId,
      transaction_amount: amount,
      transaction_date: transactionDate,
      transaction_done_by: processedBy ?? null,
      mode_of_pay: modeOfPaymentId ?? null, // 1: Cash, 2: UPI, 3: Net Banking
      transaction_utr_no: utrNumber ?? null,
      transaction_attachment: paymentScreenshotPath ?? "",
      deleted: 0,
    };

    switch (componentType) {
      case "hotel":
        await this.prisma.dvi_accounts_itinerary_hotel_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_hotel_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "vehicle":
        await this.prisma.dvi_accounts_itinerary_vehicle_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_vehicle_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "hotspot":
        await this.prisma.dvi_accounts_itinerary_hotspot_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_hotspot_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "activity":
        await this.prisma.dvi_accounts_itinerary_activity_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_activity_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      case "guide":
        await this.prisma.dvi_accounts_itinerary_guide_transaction_history.create(
          {
            data: {
              ...common,
              accounts_itinerary_guide_details_ID: componentDetailId,
            } as any,
          },
        );
        break;

      default:
        throw new BadRequestException(
          `Unsupported componentType for history: ${componentType}`,
        );
    }
  }
}

// Helpers (pure functions)

function parseDDMMYYYY(
  value?: string,
  endOfDay = false,
): Date | undefined {
  if (!value) return undefined;
  const parts = value.split("/");
  if (parts.length !== 3) return undefined;
  const [dd, mm, yyyy] = parts;
  const d = parseInt(dd, 10);
  const m = parseInt(mm, 10);
  const y = parseInt(yyyy, 10);
  if (!d || !m || !y) return undefined;

  if (endOfDay) {
    return new Date(y, m - 1, d, 23, 59, 59, 999);
  }
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function formatToDDMMYYYY(
  date?: Date | string | null,
): string {
  if (!date) return "";
  const dObj = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(dObj.getTime())) return "";
  const dd = `${dObj.getDate()}`.padStart(2, "0");
  const mm = `${dObj.getMonth() + 1}`.padStart(2, "0");
  const yyyy = dObj.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// for sorting: DD/MM/YYYY -> YYYYMMDD
function toComparable(ddmmyyyy?: string): string {
  if (!ddmmyyyy) return "";
  const [d, m, y] = ddmmyyyy.split("/");
  return `${y || "0000"}${m || "00"}${d || "00"}`;
}
