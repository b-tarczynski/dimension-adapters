// Based on dune query
// https://dune.com/queries/4959575/9826428
// https://dune.com/queries/5234847/8604606 - for refill

import { Adapter, FetchOptions, FetchResultFees } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { queryDuneSql } from "../../helpers/dune";
import { getUniqStartOfTodayTimestamp } from "../../helpers/getUniSubgraphVolume";
import request, { gql } from "graphql-request";


interface IFee {
    time: string;
    v2_fees: number;
}

const fetchSolana = async (_tt: number, _t: any, options: FetchOptions) => {
    const dayTimestamp = getUniqStartOfTodayTimestamp(new Date((options.startOfDay * 1000)))
    const targetDate = new Date(dayTimestamp * 1000).toISOString();
    const query = gql`
    {
       feesRecordDailies(where: {timestamp_eq: "${targetDate}"}) {
        tradeFees
      }
    }
  `
    const url = "https://gmx-solana-sqd.squids.live/gmx-solana-base:prod/api/graphql"
    const res = await request(url, query)
    const fees = res.feesRecordDailies
        .reduce((acc: number, record: { tradeFees: string }) => acc + Number(record.tradeFees), 0)
    if (fees === 0) throw new Error('Not found daily data!.')
    const dailyFees = fees / (10 ** 20)
    return {
        timestamp: options.startOfDay,
        dailyFees: dailyFees,
        dailyRevenue: dailyFees * 0.37,
        dailyProtocolRevenue: dailyFees * 0.1,
        dailyHoldersRevenue: dailyFees * 0.27,
    }
}

const fetch = async (_tt: number, _t: any, options: FetchOptions): Promise<FetchResultFees> => {
    const chainName = options.chain === CHAIN.AVAX ? "avalanche" : options.chain
    const fees: IFee[] = await queryDuneSql(options, `
      WITH 
      all_tokens AS (
          SELECT 
              symbol_name, contract_address, decimals, price_decimals, chain,
              CASE WHEN chain = 'avalanche' THEN 'avalanche_c' ELSE chain END AS blockchain,
              "version"
          FROM query_4420483
          WHERE symbol_name NOT LIKE '%deprecated%'
      ),

      v2_trade_fees AS (
          SELECT 
              blockchain,
              CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
              block_time, block_date, trader, market, collateral_token,
              (collateral_token_price_min + collateral_token_price_max) / 2 AS collateral_token_price,
              trade_size_usd, borrowing_fee_usd, fee_receiver_amount, fee_amount_for_pool,
              position_fee_amount, order_key, tx_hash,
              ((collateral_token_price_max + collateral_token_price_min) / 2) * liquidation_fee_amount AS liquidation_fee_usd
          FROM gmx_v2.position_fees_collected
      ),

      gmx_v2_trades AS (
          SELECT 
              trades.blockchain, trades.chain, trades.block_time, trades.block_date, 
              trades.address, trades.volume,
              fees.position_fee_amount * fees.collateral_token_price + fees.borrowing_fee_usd AS fees,
              fees.liquidation_fee_usd
          FROM (
              SELECT 
                  blockchain,
                  CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
                  block_time, block_date, account AS address, size_delta_usd AS volume,
                  tx_hash, order_key
              FROM gmx_v2.position_increase
              UNION ALL 
              SELECT 
                  blockchain,
                  CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
                  block_time, block_date, account AS address, size_delta_usd AS volume,
                  tx_hash, order_key
              FROM gmx_v2.position_decrease
          ) AS trades
          INNER JOIN v2_trade_fees AS fees ON trades.order_key = fees.order_key
      )
      , created_swap_keys AS (
          SELECT 
              blockchain,
              CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
              block_time, block_date, account, "key" AS order_key, tx_hash
          FROM gmx_v2.deposit_created
          UNION ALL
          SELECT 
              blockchain,
              CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
              block_time, block_date, account, "key" AS order_key, tx_hash
          FROM gmx_v2.withdrawal_created
          UNION ALL
          SELECT 
              blockchain,
              CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
              block_time, block_date, account, "key" AS order_key, tx_hash
          FROM gmx_v2.order_created
      ),

      executed_swap_keys AS (
          SELECT 
              creation_txs.blockchain, creation_txs.chain, creation_txs.account AS address,
              execution_txs.swap_key, execution_txs.tx_hash
          FROM (
              SELECT 
                  blockchain,
                  CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
                  block_time, block_date, "key" AS swap_key, tx_hash
              FROM gmx_v2.deposit_executed
              UNION ALL
              SELECT 
                  blockchain,
                  CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
                  block_time, block_date, "key" AS swap_key, tx_hash
              FROM gmx_v2.withdrawal_created
              UNION ALL
              SELECT 
                  blockchain,
                  CASE WHEN blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(blockchain) END AS chain,
                  block_time, block_date, "key" AS swap_key, tx_hash
              FROM gmx_v2.order_executed
          ) AS execution_txs
          INNER JOIN created_swap_keys AS creation_txs 
              ON execution_txs.swap_key = creation_txs.order_key
      ),

      v2_swaps AS (
          SELECT 
              t1.blockchain, 
              CASE WHEN t1.blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(t1.blockchain) END AS chain,
              t1.block_time, t1.block_date, t3.address, t1.market, t1.token, t2.symbol_name,
              t1.token_price, t1.fee_receiver_amount, t1.fee_amount_for_pool, t1.amount_after_fees,
              t1.action_type, t1.tx_hash
          FROM gmx_v2.swap_fees_collected AS t1
          INNER JOIN all_tokens AS t2
              ON t1.blockchain = t2.blockchain AND t1.token = t2.contract_address
          INNER JOIN executed_swap_keys AS t3
              ON t1.trade_key = t3.swap_key AND t1.blockchain = t3.blockchain
      ),

      v2_positive_price_impact AS (
          SELECT 
              blockchain, chain, block_time, block_date, NULL AS address, market,
              symbol_name, fees, 0 AS volume, 'Price Impact' AS action_type, tx_hash
          FROM (
              SELECT 
                  t1.blockchain,
                  CASE WHEN t1.blockchain = 'avalanche_c' THEN 'Avalanche' ELSE INITCAP(t1.blockchain) END AS chain,
                  t1.block_time, t1.block_date, t1.market, t1.distribution_amount, t1.tx_hash,
                  md.index_token, md.name_md AS symbol_name, pr.max_price,
                  t1.distribution_amount * pr.max_price AS fees
              FROM gmx_v2.position_impact_pool_distributed AS t1 
              INNER JOIN query_4428179 AS md
                  ON (CASE WHEN t1.blockchain = 'avalanche_c' THEN 'avalanche' ELSE t1.blockchain END) = md.chain
                  AND t1.market = md.contract_address
              INNER JOIN gmx_v2.oracle_price_update AS pr
                  ON t1.blockchain = pr.blockchain
                  AND t1.tx_hash = pr.tx_hash
                  AND md.index_token = pr.token
              WHERE t1.distribution_amount > 0
          )
      ),

      gmx_v2_swaps AS (
          SELECT
              blockchain, chain, block_time, block_date,
              token_price * (fee_receiver_amount + fee_amount_for_pool) AS fees,
              token_price * (amount_after_fees + fee_receiver_amount + fee_amount_for_pool) AS volume
          FROM v2_swaps
          UNION ALL 
          SELECT 
              blockchain, chain, block_time, block_date, fees, volume
          FROM v2_positive_price_impact
      ),

      v2_fees AS (
          SELECT 
              block_time, block_date, volume, fees, liquidation_fee_usd, chain
          FROM gmx_v2_trades
          UNION ALL
          SELECT
              block_time, block_date, volume, fees, 0 AS liquidation_fee_usd, chain
          FROM gmx_v2_swaps
      )

      SELECT 
          SUM(volume) AS volume,
          SUM(fees + liquidation_fee_usd) AS v2_fees
      FROM v2_fees
      WHERE (
          CASE '${chainName}'
              WHEN 'ALL' THEN 1=1
              WHEN 'arbitrum' THEN chain = 'Arbitrum'
              WHEN 'avalanche' THEN chain = 'Avalanche'
          END
      )
      AND TIME_RANGE
    `);

    let dailyFees = fees.reduce((acc: number, item: IFee) => acc + item.v2_fees, 0);

    return {
        dailyFees,
        dailyRevenue: `${dailyFees * 0.37}`,
        dailyProtocolRevenue: `${dailyFees * 0.1}`,
        dailyHoldersRevenue: `${dailyFees * 0.27}`,
    };
};

const adapter: Adapter = {
    version: 1,
    adapter: {
        [CHAIN.ARBITRUM]: {
            fetch,
            start: '2023-08-01',
        },
        [CHAIN.AVAX]: {
            fetch,
            start: '2023-08-24',
        },
        [CHAIN.SOLANA]: {
            fetch: fetchSolana,
            start: '2025-02-12',
        },
    },
    isExpensiveAdapter: true,
};
export default adapter;
