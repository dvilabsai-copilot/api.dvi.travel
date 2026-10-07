// FILE: src/modules/accounts-manager/accounts-manager.controller.ts

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Req,
  UploadedFile,
  UseInterceptors,
  Param,
  ParseIntPipe,
  Res,
} from "@nestjs/common";

import {
  Response,
} from "express";
import { AccountsManagerService } from "./accounts-manager.service";
import { AccountsManagerQueryDto } from "./dto/accounts-manager-query.dto";
import { AccountsManagerRowDto } from "./dto/accounts-manager-row.dto";
import {
  AccountsManagerSummaryDto,
  AccountsManagerQuoteDto,
  AccountsManagerAgentDto,
  AccountsManagerPaymentModeDto,
  AccountsManagerPayDto,
  AccountsManagerBulkPayDto,
} from "./dto/accounts-manager-extra.dto";

import {
  AccountsBulkPaymentService,
} from "./accounts-bulk-payment.service";


import {
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../../auth/jwt-auth.guard";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import * as fs from "fs";
import * as path from "path";

const resolveBackendRoot = () => path.resolve(process.cwd());

const paymentScreenshotStorage = diskStorage({
  destination: (_req, _file, cb) => {
    const dest = path.join(resolveBackendRoot(), "public", "uploads", "accounts_payment_screenshots");
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".png";
    const safeBase = path
      .basename(file.originalname || "payment_screenshot", ext)
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "payment_screenshot";
    cb(null, `${Date.now()}_${safeBase}${ext}`);
  },
});

@ApiTags("accounts-manager")
@ApiBearerAuth() // uses default bearer auth from main.ts
@Controller("accounts-manager")
export class AccountsManagerController {
constructor(
  private readonly service:
    AccountsManagerService,

  private readonly bulkPaymentService:
    AccountsBulkPaymentService,
) {}

 /**
   * Main list endpoint.
   * GET /accounts-manager
 */
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({
    summary: "List account manager rows",
    description:
      "Returns the flattened component rows (hotel/vehicle/guide/hotspot/activity) filtered by status, quote, date range, component type, agent, and search.",
  })
  @ApiOkResponse({ type: AccountsManagerRowDto, isArray: true })
 async list(
  @Req() req: any,
  @Query() query: AccountsManagerQueryDto,
): Promise<AccountsManagerRowDto[]> {
  const user = req.user;

  /*
   * Agent:
   * restrict Accounts rows to that Agent.
   */
  if (user.role === 4) {
    query.agentId =
      Number(
        user.agentId,
      );
  }

  /*
   * Staff / Travel Expert:
   * restrict rows to Agents assigned to that Staff / TE.
   *
   * IMPORTANT:
   * Do not use the existence of staffId alone here.
   * Admin users can also carry a staffId in the JWT.
   */
  else if (
    user.role === 3 ||
    user.role === 8
  ) {
    (query as any).travelExpertId =
      Number(
        user.staffId,
      );
  }

  /*
   * Admin (1) and Accounts (6):
   * no Agent / Travel Expert restriction.
   */

  return this.service.list(
    query,
  );
}

 /**
   * Summary cards (payable / paid / balance) based on same filters
   * as the list endpoint.
   * GET /accounts-manager/summary
 */
  @UseGuards(JwtAuthGuard)
  @Get("summary")
  @ApiOperation({
    summary: "Get summary totals for current filter",
    description:
      "Returns aggregated totals (totalPayable, totalPaid, totalBalance, rowCount) using the same filters as the list endpoint.",
  })
  @ApiOkResponse({ type: AccountsManagerSummaryDto })
async summary(
  @Req() req: any,
  @Query() query: AccountsManagerQueryDto,
): Promise<AccountsManagerSummaryDto> {
  const user = req.user;

  /*
   * Agent:
   * only that Agent's Accounts totals.
   */
  if (user.role === 4) {
    query.agentId =
      Number(
        user.agentId,
      );
  }

  /*
   * Staff / Travel Expert:
   * only their assigned Agents.
   */
  else if (
    user.role === 3 ||
    user.role === 8
  ) {
    (query as any).travelExpertId =
      Number(
        user.staffId,
      );
  }

  /*
   * Admin (1) and Accounts (6):
   * unrestricted Accounts summary.
   */

  return this.service.getSummary(
    query,
  );
}
 /**
   * Quote ID autocomplete – distinct itinerary_quote_ID values.
   * GET /accounts-manager/quotes?q=ABC
 */
  @Get("quotes")
  @ApiOperation({
    summary: "Search quote IDs",
    description:
      "Returns a list of matching quote IDs for the autocomplete field.",
  })
  @ApiOkResponse({ type: AccountsManagerQuoteDto, isArray: true })
  async quotes(
    @Query("q") phrase?: string,
  ): Promise<AccountsManagerQuoteDto[]> {
    return this.service.searchQuotes(phrase ?? "");
  }

 /**
   * Agent dropdown for the filter.
   * GET /accounts-manager/agents
 */
  @Get("agents")
  @ApiOperation({
    summary: "List agents for filter dropdown",
  })
  @ApiOkResponse({ type: AccountsManagerAgentDto, isArray: true })
  async agents(): Promise<AccountsManagerAgentDto[]> {
    return this.service.listAgents();
  }

 /**
   * Mode of payment list for Pay Now modal.
   * GET /accounts-manager/payment-modes
 */
  @Get("payment-modes")
  @ApiOperation({
    summary: "List modes of payment",
    description:
      "Returns the available payment modes (e.g. Cash, UPI, Net Banking) for the Pay Now modal.",
  })
  @ApiOkResponse({ type: AccountsManagerPaymentModeDto, isArray: true })
  async paymentModes(): Promise<AccountsManagerPaymentModeDto[]> {
  return this.service.listPaymentModes();
}


/**
 * Download the complete Purchase Cost / Package PDF
 * for one Accounts booking.
 *
 * headerId = accounts_itinerary_details_ID
 */
@UseGuards(
  JwtAuthGuard,
)
@Get(
  "purchase-cost-pdf/:headerId",
)
@ApiOperation({
  summary:
    "Download confirmed itinerary purchase cost PDF",
})
async purchaseCostPdf(
  @Req()
  req: any,

  @Param(
    "headerId",
    ParseIntPipe,
  )
  headerId: number,

  @Res()
  res: Response,
): Promise<void> {
  const scope:
    AccountsManagerQueryDto =
    {
      status:
        "all",

      componentType:
        "all",
    };


  const user =
  req.user;


/*
 * Keep the same role scope as the Accounts
 * list and summary endpoints.
 */
if (
  user.role === 4
) {
  /*
   * Agent:
   * only their own Accounts booking.
   */
  scope.agentId =
    Number(
      user.agentId,
    );
} else if (
  user.role === 3 ||
  user.role === 8
) {
  /*
   * Staff / Travel Expert:
   * only bookings belonging to their Agents.
   */
  (
    scope as any
  ).travelExpertId =
    Number(
      user.staffId,
    );
}

/*
 * Admin (1) and Accounts (6):
 * no Agent / Travel Expert restriction.
 */


  await this.service
    .downloadPurchaseCostPdf(
      headerId,
      res,
      scope,
    );
}


/**
 * Pay Now – updates total_paid and total_balance for a component row.
 * POST /accounts-manager/pay
 */
@Post("pay")
  @ApiOperation({
    summary: "Record a payment against a component row",
    description:
      "Updates the per-component totals (total_paid and total_balance) for the specified hotel/vehicle/guide/hotspot/activity row.",
  })
 @ApiBearerAuth() // optional (redundant but explicit for this route)
  @ApiBody({ type: AccountsManagerPayDto })
  @ApiOkResponse({ description: "Payment recorded" })
  @UseInterceptors(
    FileInterceptor("paymentScreenshot", {
      storage: paymentScreenshotStorage,
    }),
  )
  async pay(
    @Body() body: AccountsManagerPayDto,
    @UploadedFile() paymentScreenshot?: Express.Multer.File,
  ): Promise<void> {
    const normalizedBody: AccountsManagerPayDto = {
      ...body,
      accountsItineraryDetailsId: Number((body as any).accountsItineraryDetailsId ?? 0),
      componentDetailId: Number((body as any).componentDetailId ?? 0),
      amount: Number((body as any).amount ?? 0),
      modeOfPaymentId:
        (body as any).modeOfPaymentId !== undefined && (body as any).modeOfPaymentId !== ""
          ? Number((body as any).modeOfPaymentId)
          : undefined,
      paymentScreenshotPath: paymentScreenshot
        ? `/uploads/accounts_payment_screenshots/${paymentScreenshot.filename}`
        : String((body as any).paymentScreenshotPath ?? "").trim() || undefined,
    };
    return this.service.recordPayment(normalizedBody);
  }


/*
 * ============================================================
 * BULK PAYMENT
 * ============================================================
 *
 * One shared Payment Mode / UTR / Processed By / Screenshot,
 * but every selected task keeps its own balance and history row.
 */
@UseGuards(
  JwtAuthGuard,
)
@Post(
  "pay-bulk",
)
@ApiBearerAuth()
@ApiOperation({
  summary:
    "Record one payment across multiple payment tasks",
  description:
    "Records one shared payment reference across multiple due component rows belonging to the same supplier/vendor.",
})
@ApiBody({
  type:
    AccountsManagerBulkPayDto,
})
@ApiOkResponse({
  description:
    "Bulk payment recorded",
})
@UseInterceptors(
  FileInterceptor(
    "paymentScreenshot",
    {
      storage:
        paymentScreenshotStorage,
    },
  ),
)
async payBulk(
  @Body()
  body:
    AccountsManagerBulkPayDto,

  @UploadedFile()
  paymentScreenshot?:
    Express.Multer.File,
): Promise<void> {
  let rawPayments:
    any =
    (
      body as any
    ).payments;


  /*
   * multipart/form-data sends payments as JSON text.
   */
  if (
    typeof rawPayments ===
    "string"
  ) {
    try {
      rawPayments =
        JSON.parse(
          rawPayments,
        );
    } catch {
      throw new BadRequestException(
        "Invalid bulk payments payload.",
      );
    }
  }


  if (
    !Array.isArray(
      rawPayments,
    )
  ) {
    throw new BadRequestException(
      "Payments must be an array.",
    );
  }


  if (
    rawPayments.length ===
    0
  ) {
    throw new BadRequestException(
      "Select at least one payment task.",
    );
  }


  const normalizedBody:
    AccountsManagerBulkPayDto =
    {
      ...body,


      payments:
        rawPayments.map(
          (
            payment:
              any,
          ) => ({
            ...payment,


            accountsItineraryDetailsId:
              Number(
                payment
                  .accountsItineraryDetailsId ||
                  0,
              ),


            componentDetailId:
              Number(
                payment
                  .componentDetailId ||
                  0,
              ),


            amount:
              Number(
                payment
                  .amount ||
                  0,
              ),


            routeDate:
              String(
                payment
                  .routeDate ||
                  "",
              ).trim() ||
              undefined,
          }),
        ),


      modeOfPaymentId:
        (
          body as any
        ).modeOfPaymentId !==
          undefined &&
        (
          body as any
        ).modeOfPaymentId !==
          ""
          ? Number(
              (
                body as any
              ).modeOfPaymentId,
            )
          : undefined,


      utrNumber:
        String(
          (
            body as any
          ).utrNumber ||
            "",
        ).trim() ||
        undefined,


      processedBy:
        String(
          (
            body as any
          ).processedBy ||
            "",
        ).trim() ||
        undefined,


      paymentScreenshotPath:
        paymentScreenshot
          ? `/uploads/accounts_payment_screenshots/${paymentScreenshot.filename}`
          : String(
              (
                body as any
              )
                .paymentScreenshotPath ||
                "",
            ).trim() ||
            undefined,
    };


  return this
    .bulkPaymentService
    .recordBulkPayment(
      normalizedBody,
    );
}

}
