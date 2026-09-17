import { defineComponent } from '@openuidev/react-lang';
import {
  DATA_COMPONENT_DESCRIPTIONS,
  dataChartPropsSchema,
  dataSummaryPropsSchema,
  dataTablePropsSchema,
  type DataChartProps,
  type DataSummaryProps,
  type DataTableProps,
} from '@platform/contracts';
import { DataChartView } from './DataChart.tsx';
import { DataSummaryView } from './DataSummary.tsx';
import { DataTableView } from './DataTable.tsx';

/**
 * The platform's data components, as the OpenUI catalog offers them.
 *
 * Their props schemas are the contracts' (`@platform/contracts`), not a copy,
 * so the server can validate a composition against exactly what the browser
 * renders. Registered in every catalog `buildRegistry` produces — module views,
 * `openui` cards and the chat use one library.
 */
export const platformDataComponents = [
  defineComponent({
    name: 'DataTable',
    description: DATA_COMPONENT_DESCRIPTIONS.DataTable,
    props: dataTablePropsSchema,
    component: ({ props }) => <DataTableView {...(props as DataTableProps)} />,
  }),
  defineComponent({
    name: 'DataChart',
    description: DATA_COMPONENT_DESCRIPTIONS.DataChart,
    props: dataChartPropsSchema,
    component: ({ props }) => <DataChartView {...(props as DataChartProps)} />,
  }),
  defineComponent({
    name: 'DataSummary',
    description: DATA_COMPONENT_DESCRIPTIONS.DataSummary,
    props: dataSummaryPropsSchema,
    component: ({ props }) => <DataSummaryView {...(props as DataSummaryProps)} />,
  }),
];
