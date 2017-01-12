package parser

import (
	"testing"

	"github.com/bakape/meguca/config"
	"github.com/bakape/meguca/db"
)

func init() {
	db.DBName = "meguca_test_parser"
	db.IsTest = true
	if err := db.LoadDB(); err != nil {
		panic(err)
	}
	config.Set(config.Configs{})
}

func assertTableClear(t *testing.T, tables ...string) {
	if err := db.ClearTables(tables...); err != nil {
		t.Fatal(err)
	}
}

func assertInsert(t *testing.T, table string, doc interface{}) {
	if err := db.Insert(table, doc); err != nil {
		t.Fatal(err)
	}
}
