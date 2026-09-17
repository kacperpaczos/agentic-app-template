import { defineComponent } from '@openuidev/react-lang';
import {
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
    description:
      'Tabela rekordow zarejestrowanej operacji odczytu. Dane pobiera backend; podaj zrodlo {operation, input} ' +
      'i opcjonalnie kolumny (pola deskryptora), tytul, rozmiar strony, stale zawezenie i porzadek. Nigdy nie wpisuj wartosci.',
    props: dataTablePropsSchema,
    component: ({ props }) => <DataTableView {...(props as DataTableProps)} />,
  }),
  defineComponent({
    name: 'DataChart',
    description:
      'Wykres (bar, line, pie) rekordow zarejestrowanej operacji odczytu: kategorie z pola x, serie z pol liczbowych ' +
      'deskryptora. Dane i jednostki pochodza z backendu; podpis podaje serie, jednostke i zakres wartosci.',
    props: dataChartPropsSchema,
    component: ({ props }) => <DataChartView {...(props as DataChartProps)} />,
  }),
  defineComponent({
    name: 'DataSummary',
    description:
      'Podsumowanie rekordow zarejestrowanej operacji odczytu jako pary etykieta-wartosc dla wskazanych pol deskryptora.',
    props: dataSummaryPropsSchema,
    component: ({ props }) => <DataSummaryView {...(props as DataSummaryProps)} />,
  }),
];
